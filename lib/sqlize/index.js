'use strict';

const filter = require('lodash/filter');
const forEach = require('lodash/forEach');
const get = require('lodash/get');
const Hooks = require('./hooks');
const invoke = require('lodash/invoke');
const map = require('lodash/map');
const mapKeys = require('lodash/mapKeys');
const parseISO = require('date-fns/parseISO');
const pick = require('lodash/pick');
const pkg = require('../../package.json');
const reduce = require('lodash/reduce');
const result = require('lodash/result');
const semver = require('semver');
const Sequelize = require('sequelize');
const transform = require('lodash/transform');
const Umzug = require('umzug');
const withEvents = require('./events');

const isFunction = arg => typeof arg === 'function';
const isModel = Ctor => Ctor && Ctor.prototype instanceof Sqlize.Model;
const isProduction = process.env.NODE_ENV === 'production';

class Sqlize extends withEvents(Sequelize) {
  constructor(config) {
    // NOTE: Turn on type validation for database queries.
    if (config.typeValidation !== false) config.typeValidation = true;
    config.url ? super(config.url, config) : super(config);
    this.initialize = this.initialize.bind(this);

    // NOTE: Override `QueryInterface#bulkInsert` to support custom field names.
    //       Fixes: https://github.com/sequelize/sequelize/commit/47489ab1#r34601439
    const queryInterface = this.getQueryInterface();
    const { bulkInsert } = queryInterface;
    queryInterface.bulkInsert = function (tableName, records, options, attributes) {
      if (options.upsertKeys) {
        const primaryKeyColumns = map(filter(attributes, 'primaryKey'), 'field');
        const upsertKeyColumns = map(filter(attributes, 'upsertKey'), 'field');
        options.upsertKeys = upsertKeyColumns.length > 0
          ? upsertKeyColumns
          : primaryKeyColumns;
      }
      return bulkInsert.call(this, tableName, records, options, attributes);
    };

    // NOTE: Override `dialect#Query` constructor to default `includeMap` option
    //       to support `hasJoin` option in raw queries, i.e. associated models mapping.
    //       More info: https://github.com/ExtensionEngine/penn/pull/330#discussion_r402644234
    const QueryCtor = this.dialect.Query.prototype.constructor;
    this.dialect.Query = class extends QueryCtor {
      constructor(connection, sequelize, options) {
        if (!options.includeMap) options.includeMap = {};
        super(connection, sequelize, options);
      }
    };
  }

  log(query, time) {
    const { logger } = this.options;
    const info = { query };
    if (time) info.duration = `${time}ms`;
    return logger.debug(info);
  }

  register(models) {
    this.$models = models;
    forEach(models, Model => this.define(Model));
    forEach(models, Model => {
      invoke(Model, 'associate', models);
      addHooks(Model, Hooks, models);
      addScopes(Model, models);
    });
  }

  // Patch `Sequelize#model` to support getting models by class name.
  model(name) {
    return this.$models[name] || super.model(name);
  }

  define(Model) {
    // Keep backwards compatibility.
    if (!isModel(Model)) return super.define(...arguments);
    const { DataTypes, Promise } = this.Sequelize;
    let fields = invoke(Model, 'fields', DataTypes, this) || {};
    const options = invoke(Model, 'options') || {};
    if (options.freezeTableName !== false) options.freezeTableName = true;
    if (options.paranoid !== false) options.paranoid = true;
    if (options.timestamps !== false) options.timestamps = true;
    fields = this.addDefaultFields(fields, options);
    this.wrapMethods(Model, Promise);
    Model.init(fields, { ...options, sequelize: this });
    return Model;
  }

  addDefaultFields(fields, options) {
    if (options.timestamps) fields = this.addTimestamps(fields, options);
    return fields;
  }

  addTimestamps(fields, options) {
    const { DataTypes } = this.Sequelize;
    const tail = {};
    if (options.createdAt !== false) {
      const field = options.createdAt || 'created_at';
      Object.assign(tail, {
        createdAt: {
          field,
          _autoGenerated: true,
          type: DataTypes.DATE,
          allowNull: false
        }
      });
    }
    if (options.updatedAt !== false) {
      const field = options.updatedAt || 'updated_at';
      Object.assign(tail, {
        updatedAt: {
          field,
          _autoGenerated: true,
          type: DataTypes.DATE,
          allowNull: false
        }
      });
    }
    if (options.deletedAt !== false) {
      const field = options.deletedAt || 'deleted_at';
      Object.assign(tail, {
        deletedAt: {
          field,
          _autoGenerated: true,
          type: DataTypes.DATE
        }
      });
    }
    return Object.assign({}, fields, tail);
  }

  wrapMethods(Model, Promise) {
    let Ctor = Model;
    do {
      const properties = Reflect.ownKeys(Ctor.prototype);
      const staticProperties = Reflect.ownKeys(Ctor);
      forEach(properties, key => wrapMethod(Ctor.prototype, key, Promise));
      forEach(staticProperties, key => wrapMethod(Ctor, key, Promise));
    } while ((Ctor = Object.getPrototypeOf(Ctor)) && Ctor !== Sequelize.Model);
    return Model;
  }

  async initialize(otherDb = {}) {
    this.$sequelize = otherDb.sequelize;
    const { logger } = this.options;
    await this.authenticate();
    logger.info(getConfig(this), '🗄️  Connected to database');
    await this.checkDatabaseVersion();
    const migrations = await this.migrate();
    const files = migrations.map(it => it.file);
    if (!files.length) return;
    logger.info({ migrations: files }, '🗄️  Executed migrations:\n', files.join('\n'));
    await this.initSystemMeta({ versions: {} });
    return this;
  }

  initSystemMeta(records, options) {
    const SystemMeta = this.queryInterface.sequelize.model('SystemMeta');
    if (!SystemMeta) return;
    const items = map(records, (data, name) => ({ name, data }));
    return SystemMeta.bulkCreate(items, { ignoreDuplicates: true, ...options });
  }

  async checkDatabaseVersion() {
    const { dialect, logger } = this.options;
    const version = await this.getQueryInterface().databaseVersion();
    logger.info({ version }, `${dialect} version:`, version);
    const range = pkg.engines && pkg.engines[dialect];
    if (!range) return this;
    if (semver.satisfies(semver.coerce(version), range)) return this;
    const err = new Error(`"${pkg.name}" requires ${dialect} ${range}`);
    logger.error({ version, required: range }, err.message);
    throw err;
  }

  async migrate() {
    const { logger, migrationsPath, migrationStorageTableName } = this.options;
    const umzug = new Umzug({
      storage: 'sequelize',
      storageOptions: {
        sequelize: this,
        tableName: migrationStorageTableName
      },
      migrations: {
        params: [this.getQueryInterface(), this.Sequelize],
        path: migrationsPath
      },
      logging(message) {
        if (message.startsWith('==')) return;
        if (message.startsWith('File:')) {
          const file = message.split(/\s+/g)[1];
          return logger.info({ file }, message);
        }
        return logger.info(message);
      }
    });

    umzug.on('migrating', m => logger.info({ migration: m }, '⬆️  Migrating:', m));
    umzug.on('migrated', m => logger.info({ migration: m }, '⬆️  Migrated:', m));
    umzug.on('reverting', m => logger.info({ migration: m }, '⬇️  Reverting:', m));
    umzug.on('reverted', m => logger.info({ migration: m }, '⬇️  Reverted:', m));

    if (!isProduction) await umzug.up();
    return umzug.executed();
  }

  query(sql, options) {
    const { logger } = this.options;
    return super.query(sql, options).catch(err => {
      const ctx = { err };
      if (err.sql) ctx.query = err.sql;
      logger.error(ctx, '🚨  Database error:', err.message);
      this.emit('error', err);
      return Promise.reject(err);
    });
  }
}

Sqlize.Model = class extends Sequelize.Model {
  static get $sequelize() {
    return this.sequelize.$sequelize;
  }

  static get uniqueIndices() {
    const { rawAttributes } = this;
    const indices = transform(rawAttributes, (acc, { field, unique }) => {
      if (!unique || acc[unique]) return;
      if (unique === true) acc[field] = [field];
      else {
        acc[unique] = map(filter(rawAttributes, { unique }), 'field');
      }
    });
    return Object.values(indices);
  }

  static init(attributes, options) {
    super.init(attributes, options);
    this.$writableAttributes = reduce(this.rawAttributes, (acc, options, name) => {
      const isReadOnly = this._readOnlyAttributes.has(options.fieldName);
      if (options.primaryKey || isReadOnly) return acc;
      return Object.assign(acc, { [name]: options });
    }, {});
    return this;
  }

  static async getSystemMeta(name, options = {}) {
    const SystemMeta = this.sequelize.model('SystemMeta');
    const [sm] = await SystemMeta.findOrCreate({ where: { name }, ...options });
    return sm;
  }

  static async getVersion(options) {
    const path = ['data', this.name];
    const sm = await this.getSystemMeta('versions', options);
    const version = get(sm, path);
    return version ? parseISO(version) : new Date(0);
  }

  static async setVersion(version, options) {
    const sm = await this.getSystemMeta('versions', options);
    const path = ['data', this.name].join('.');
    await sm.set(path, version);
    return sm.save();
  }

  static async increment(fields, options) {
    const [[rows]] = await super.increment(fields, options);
    return map(rows, row => {
      const data = mapKeys(row, (_, key) => this.fieldAttributeMap[key] || key);
      return new this(data);
    });
  }

  static getRawAttrs(attributes) {
    const { rawAttributes, name } = this;
    return Object.values(pick(rawAttributes, attributes))
      .map(({ field }) => `"${name}"."${field}"`);
  }
};

module.exports = Sqlize;

function addHooks(Model, Hooks, models) {
  const hooks = invoke(Model, 'hooks', Hooks, models);
  forEach(hooks, (it, type) => Model.addHook(type, it));
}

function addScopes(Model, models) {
  const scopes = invoke(Model, 'scopes', models);
  forEach(scopes, (scope, name) => {
    if (name === 'defaultScope') scope = result(scopes, 'defaultScope');
    Model.addScope(name, scope, { override: true });
  });
}

function wrapMethod(object, key, Promise) {
  try {
    if (key === 'constructor') return;
    const { value } = Reflect.getOwnPropertyDescriptor(object, key);
    if (!isFunction(value)) return;
    object[key] = function () {
      const result = value.apply(this, arguments);
      if (!result || !isFunction(result.catch)) return result;
      return Promise.resolve(result);
    };
  } catch (err) {
    console.error(err);
    throw err;
  }
}

function getConfig(sequelize) {
  // NOTE: List public fields:
  // https://github.com/sequelize/sequelize/blob/v5.12.2/lib/sequelize.js#L280-L295
  return pick(sequelize.config, [
    'database', 'username', 'host', 'port', 'protocol',
    'pool',
    'native',
    'ssl',
    'replication',
    'dialectModulePath',
    'keepDefaultTimezone',
    'dialectOptions'
  ]);
}
