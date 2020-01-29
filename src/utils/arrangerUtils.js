import flatten from "lodash/flatten";
import isPlainObject from "lodash/isPlainObject";
import isEmpty from "lodash/isEmpty";

/**
 * An in-memory, asynchronous cache.
 */
class AsyncCache {
  /**
   * Time to live of an item in the cache
   */
  _ttl = 24 * 60 * 60 * 1000;

  // a day in ms
  _entries = {};

  /**
   * Get an entry from the cache, and populate it if missing.
   * @param {string} key - the unique identifier of that item
   * @param {function(string)} fetch - a function that will populated this entry if it is missing.
   * @returns {Promise<any>} a promise to the entry matching the `key`, or a rejected promise if not found.
   */
  get(key, fetch) {
    if (!this._entries[key]) {
      this.add(key, fetch(key));
    }
    return this._entries[key].entry;
  }

  /**
   * Add an entry to the cache.
   * @param {string} key - the unique identifier of that item.
   * @param {Promise<any>} entry - a Promise of the entry to be added to the cache.
   */
  add(key, value) {
    this._entries[key] = {
      key,
      entry: typeof value.then === "function" ? value : Promise.resolve(value),
      expiry: Date.now() + this._ttl
    };
    this.clean();
  }

  /**
   *
   * @param {string} key - voids an entry in the cache.
   */
  remove(key) {
    delete this._entries[key];
  }

  /**
   * Remove stale entries from the cache
   */
  clean() {
    const now = Date.now();
    this._entries = Object.entries(this._entries).reduce(
      (freshEntries, [key, entry]) => {
        if (entry.expiry > now) {
          freshEntries[key] = entry;
        }
        return freshEntries;
      },
      {}
    );
  }
}

const _internalCache = new AsyncCache();

const fetchProject = (es, projectId, indexName) => {
  const key = generateCacheKey(projectId, indexName);

  return es
    .search({
      index: `arranger-projects-${projectId}`,
      type: `arranger-projects-${projectId}`,
      q: `name:${indexName}`
    })
    .then(({ body }) => body.hits.hits.map(hit => hit._source))
    .then(sources => sources.map(source => source.config.extended))
    .then(extendedConfigs => {
      if (extendedConfigs.length === 0) {
        throw new Error(
          `Could not find project for "projectId: ${projectId}, indexName: ${indexName}"`
        );
      }
      if (extendedConfigs.length > 1) {
        console.warn(
          `Found more than one config matching "projectId: ${projectId}, indexName: ${indexName}", picking the first one.`
        );
      }
      return extendedConfigs[0];
    })
    .catch(err => {
      _internalCache.remove(key);
      console.error(
        `Error while fetching project for "projectId: ${projectId}, indexName: ${indexName}"`,
        err
      );
      throw err;
    });
};

const generateCacheKey = (projectId, indexName) => `${projectId} ${indexName}`;

/**
 * Get an arranger project's extended configs.
 * @param {object} es - an `elasticsearch.Client` instance.
 * @param {string} projectId - the id of the arranger project.
 * @param {string} indexName - the value of `name` in the arranger project indices. Usually `participant` or `file`.
 * @returns {Promise<object>} - the arranger project configurations for the given `indexName`.
 */
export const getExtendedConfigs = async (es, projectId, indexName) => {
  const key = generateCacheKey(projectId, indexName);
  return _internalCache.get(key, () => fetchProject(es, projectId, indexName));
};

/**
 * Extracts the fields path for fields of type "nested".
 * @param {Object} extendedConfigs - the extended configurations from the mappings.
 * @returns {string[]} - an array of fields path.
 */
export const getNestedFields = extendedConfigs => {
  return extendedConfigs
    .filter(({ type }) => type === "nested")
    .map(({ field }) => field);
};

/**
 * Like `lodash.get`, but supports paths containing arrays.
 * In the case of a path containing one or more array, the results will be flattened.
 * @param {object} source - a row in an ES response
 * @param {String} path - the path to the field
 * @param {String} defaultValue - (optional) the value to be returned if the field is not found or null
 * @returns {any|any[]} a single value, or a flattened array of scalar values if the path contains an array
 */
export const findValueInField = (source, path, defaultValue = null) => {
  const pathSegments = path.split(".");
  const result = pathSegments.reduce((value, segment) => {
    if (Array.isArray(value)) {
      return flatten(value)
        .map(v => v[segment])
        .filter(v => v !== undefined);
    }
    return value && value[segment];
  }, source);
  return result === undefined ? defaultValue : result;
};

/**
 * Recursive function that breaks the targeted element into its irreducible parts (e.g [{}, {}, {}] => [{}] [{}] [ {}])
 * and returns an array where each element is the source object modified only at its targeted path in such a way that
 * each value pointed by this path is an irreducible part of the targeted element.
 * 
 * @examples

  1) for path = 'a.b.c.d',
    { a: b: { c : [ { d: 1 }, { d: 2 } ] } } => [{ a: b: { c : { d: 1 } } }, { a: b: { c : { d: 2 } } }]
 
  2) for path = 'b.c.d'
     {  a: 1,b: {c: [{ d: 1}, { d: 2}]}, e: 4} => [ {a: 1, b: {c: {d: 1}}, e: 4}, {a: 1, b: {c: {d: 2}}, e: 4} ]
 
 * @param {object} source - any object
 * @param {object} currentLevel - the name of a property of `source`
 * @param {array} segments - path split (a.b => ['a', 'b'])`
 * @returns {object[]}
 *
 */
const deepObjectMapFromNode = (source, currentLevel, segments) => {
  const currentPathName = segments.slice(0, 1);
  const nextPath = segments.slice(1);
  const hasNextPath = nextPath.length > 0;

  const currentValues = currentLevel[currentPathName];

  const flattenUntilIrreducibility = currentNode => {
    const irreducible = deepObjectMapFromNode(
      source,
      currentNode,
      nextPath
    );
    return irreducible.map(deepestTarget => ({
      ...currentLevel,
      [currentPathName]: deepestTarget
    }));
  };

  if (!Array.isArray(currentValues)) {
    if (
      isPlainObject(currentValues) &&
      !isEmpty(currentValues) &&
      hasNextPath
    ) {
      // deeper level(s) to explore
      return flattenUntilIrreducibility({ ...currentValues });
    }
    // deepest level targeted has been reached
    return [currentLevel];
  }

  return currentValues.reduce((result, item) => {
    return [...result, ...flattenUntilIrreducibility(item)];
  }, []);
};

/**
 * Wrapper around generateColumnsForProperty
 * @param {object} source - any object
 * @param {string} path - the name of a property of `source`
 * @returns {object[]}
 */
export const generateColumnsForProperty = (source, path) => {
  const pathSegments = path.split(".");
  return deepObjectMapFromNode(source, source, pathSegments);
};
