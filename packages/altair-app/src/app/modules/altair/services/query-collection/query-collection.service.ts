import { from as observableFrom, of } from 'rxjs';
import { Injectable } from '@angular/core';
import { v4 as uuid } from 'uuid';
import {
  ExportCollectionState,
  IQuery,
  IQueryCollection,
  IQueryCollectionTree,
} from 'altair-graphql-core/build/types/state/collection.interfaces';
import { StorageService } from '../storage/storage.service';
import { debug } from '../../utils/logger';
import { getFileStr, str } from '../../utils';
import { ApiService } from '../api/api.service';
import { AccountService } from '../account/account.service';

type CollectionID = number | string;
type QueryID = string;
const COLLECTION_PATH_SEPARATOR = '/';

// Handling hierarchical data
// https://stackoverflow.com/questions/4048151/what-are-the-options-for-storing-hierarchical-data-in-a-relational-database
// https://github.com/dexie/Dexie.js/issues/749
@Injectable()
export class QueryCollectionService {
  constructor(
    private storage: StorageService,
    private api: ApiService,
    private accountService: AccountService
  ) {}

  async create(
    collection: IQueryCollection,
    parentCollectionId?: CollectionID
  ) {
    const newCollectionId = await this.createLocalCollection(
      collection,
      parentCollectionId
    );

    // Remote - don't add to remote yet, until user explicitly syncs

    return newCollectionId;
  }

  private async canApplyRemote() {
    return !!(await this.accountService.getUser());
  }

  async createRemoteCollection(
    localCollectionId: CollectionID,
    collection: IQueryCollection
  ) {
    if (!(await this.canApplyRemote())) {
      // not logged in
      return;
    }

    // Get parent collection, retrieve parent collection server id, set parent collection id in remote
    const parentCollection = await this.getParentCollection(collection);
    const parentCollectionServerId = parentCollection?.serverId
      ? `${parentCollection.serverId}`
      : undefined;

    const res = await this.api.createQueryCollection(
      collection,
      parentCollectionServerId
    );

    if (!res) {
      throw new Error('could not create the collection');
    }

    // Add serverId to local query and collection data
    const localCollection = await this.mustGetLocalCollection(
      localCollectionId
    );
    localCollection.serverId = res.collectionId;
    localCollection.queries = localCollection.queries.map((query, idx) => {
      query.serverId = res.queryIds[idx];
      return query;
    });
    return this.updateLocalCollection(localCollectionId, localCollection);
  }

  private async createLocalCollection(
    collection: IQueryCollection,
    parentCollectionId?: CollectionID
  ) {
    const now = this.storage.now();
    let parentPath = '';
    if (parentCollectionId) {
      parentPath = await this.getSubcollectionParentPath(parentCollectionId);
    }

    collection.queries = collection.queries.map((query) => {
      return { ...query, id: uuid(), created_at: now, updated_at: now };
    });

    return this.storage.queryCollections.add({
      ...collection,
      id: uuid(),
      parentPath,
      created_at: now,
      updated_at: now,
    });
  }

  async addQuery(collectionId: CollectionID, query: IQuery) {
    const res = await this.addLocalQuery(collectionId, query);

    const localCollection = await this.mustGetLocalCollection(collectionId);

    if (!(await this.canApplyRemote())) {
      // not logged in
      return;
    }

    if (localCollection.serverId) {
      // only add query to remote if already synced
      await this.addRemoteQuery(collectionId, [query]);
    }
  }

  private async addRemoteQuery(collectionId: CollectionID, queries: IQuery[]) {
    const localCollection = await this.mustGetLocalCollection(collectionId);
    if (!localCollection.serverId) {
      debug.warn(
        'All remote queries must have an existing collection server ID'
      );
      return;
    }
    const queryServerIds = await this.api.createQueries(
      `${localCollection.serverId}`,
      queries
    );

    if (!queryServerIds.length) {
      throw new Error('Could not add query in collection to remote');
    }

    // update local query with server ID
    for (const [idx, queryServerId] of queryServerIds.entries()) {
      await this.updateLocalQuery(collectionId, queryServerId, {
        ...queries[idx],
        serverId: queryServerId,
      });
    }
  }

  private async addLocalQuery(collectionId: CollectionID, query: IQuery) {
    const now = this.storage.now();
    return this.updateCollectionByID(collectionId, (collection) => {
      const uQuery = { ...query, id: uuid(), created_at: now, updated_at: now };
      collection.queries.push(uQuery);
    });
  }

  async updateQuery(
    collectionId: CollectionID,
    queryId: QueryID,
    query: IQuery
  ) {
    const res = await this.updateLocalQuery(collectionId, queryId, query);

    if (!(await this.canApplyRemote())) {
      // not logged in
      return;
    }
    const localCollection = await this.mustGetLocalCollection(collectionId);
    // only update remote if already synced
    if (!localCollection.serverId) {
      return;
    }
    const localQuery = await this.getLocalQuery(collectionId, queryId);
    if (!localQuery?.serverId) {
      return this.addRemoteQuery(collectionId, [query]);
    }

    await this.api.updateQuery(`${localQuery.serverId}`, query);

    return res;
  }

  private getAlternateCollectionID(collectionId: CollectionID) {
    let alternateCollectionId: number | string = '';
    if (typeof collectionId === 'number') {
      alternateCollectionId = `${collectionId}`;
    }
    if (typeof collectionId === 'string') {
      alternateCollectionId = Number(collectionId);
      if (isNaN(alternateCollectionId)) {
        // we don't want to query with NaN as ID
        alternateCollectionId = '';
      }
    }

    return alternateCollectionId;
  }

  async getCollectionByID(collectionId: CollectionID) {
    const localCollection = await this.storage.queryCollections.get(
      collectionId
    );
    if (!localCollection) {
      collectionId = this.getAlternateCollectionID(collectionId);
    }
    return await this.storage.queryCollections.get(collectionId);
  }

  private async updateCollectionByID(
    collectionId: CollectionID,
    changeCb: (
      obj: IQueryCollection,
      ctx: { value: IQueryCollection }
    ) => boolean | void
  ) {
    const alternateCollectionId = this.getAlternateCollectionID(collectionId);
    return this.storage.queryCollections
      .where('id')
      .equals(collectionId)
      .or('id')
      .equals(alternateCollectionId)
      .modify(changeCb);
  }

  private async mustGetLocalCollection(collectionId: CollectionID) {
    const localCollection = await this.getCollectionByID(collectionId);
    if (!localCollection) {
      throw new Error('Could not retrieve local collection data');
    }
    return localCollection;
  }

  private async getLocalQuery(collectionId: CollectionID, queryId: QueryID) {
    const localCollection = await this.getCollectionByID(collectionId);
    if (localCollection) {
      return localCollection.queries.find((query) => query.id === queryId);
    }
  }

  private updateLocalQuery(
    collectionId: CollectionID,
    queryId: QueryID,
    query: IQuery
  ) {
    const now = this.storage.now();
    return this.updateCollectionByID(collectionId, (collection) => {
      const uQuery = { ...query, id: queryId, updated_at: now };
      collection.queries = collection.queries.map((collectionQuery) => {
        if (collectionQuery.id === queryId) {
          collectionQuery = { ...collectionQuery, ...uQuery };
        }
        return collectionQuery;
      });

      // collection.updated_at = now;
    });
  }

  async deleteQuery(collectionId: CollectionID, query: IQuery) {
    const localCollection = await this.mustGetLocalCollection(collectionId);
    const localQuery = await this.getLocalQuery(collectionId, query.id!);
    await this.deleteLocalQuery(collectionId, query);

    if (!(await this.canApplyRemote())) {
      // not logged in
      return;
    }
    if (!localCollection.serverId) {
      // only update remote if collection is synced
      return;
    }
    // delete query remote
    if (!query.id) {
      // ignore these cases as malformed queries
      debug.log('Query does not have id. Skipping remote check.');
      return;
    }

    if (!localQuery?.serverId) {
      debug.log('Query does not have server id. Skipping remote check.');
      return;
    }

    await this.api.deleteQuery(`${localQuery.serverId}`);
  }

  private deleteLocalQuery(collectionId: CollectionID, query: IQuery) {
    return this.updateCollectionByID(collectionId, (collection) => {
      collection.queries = collection.queries.filter((collectionQuery) => {
        if (query.id) {
          if (query.id === collectionQuery.id) {
            return false;
          }
        } else {
          // Added for backward compatibility. Initially queries didn't have ids. Remove after a while.
          if (query.windowName === collectionQuery.windowName) {
            return false;
          }
        }

        return true;
      });

      // collection.updated_at = this.storage.now();
    });
  }

  async deleteCollection(collectionId: CollectionID) {
    const localCollection = await this.mustGetLocalCollection(collectionId);
    await this.deleteLocalCollection(collectionId);
    // Note: Deleting a collection would delete all subcollections and queries inside the collection

    // delete collection remote
    if (!(await this.canApplyRemote())) {
      // not logged in
      return;
    }
    if (!localCollection.serverId) {
      debug.log('collection does not have server id. Skipping remote check.');
      return;
    }

    await this.api.deleteCollection(`${localCollection.serverId}`);
  }

  async deleteLocalCollection(collectionId: CollectionID) {
    await this.storage.queryCollections.delete(collectionId);
    await this.storage.queryCollections.delete(
      this.getAlternateCollectionID(collectionId)
    );
  }

  async updateCollection(
    collectionId: CollectionID,
    modifiedCollection: IQueryCollection
  ) {
    const res = await this.updateLocalCollection(
      collectionId,
      modifiedCollection
    );

    const localCollection = await this.mustGetLocalCollection(collectionId);

    if (!localCollection.serverId) {
      // only update if synced
      return;
    }

    // update collection remote
    await this.updateRemoteCollection(collectionId);

    return res;
  }

  async updateRemoteCollection(collectionId: CollectionID) {
    if (!(await this.canApplyRemote())) {
      // not logged in
      return;
    }
    const localCollection = await this.mustGetLocalCollection(collectionId);
    const parentCollection = await this.getParentCollection(localCollection);

    await this.api.updateCollection(
      `${localCollection.serverId}`,
      localCollection,
      str(parentCollection?.serverId)
    );
  }

  private updateLocalCollection(
    collectionId: CollectionID,
    modifiedCollection: IQueryCollection
  ) {
    return this.updateCollectionByID(collectionId, (collection, ctx) => {
      ctx.value = modifiedCollection;
      ctx.value.updated_at = this.storage.now();
    });
  }

  async getExportCollectionData(collectionId: CollectionID) {
    const collectionTree = await this.getCollectionTreeByCollectionId(
      collectionId
    );
    const exportCollectionData: ExportCollectionState = {
      version: 1,
      type: 'collection',
      ...collectionTree,
    };
    return exportCollectionData;
  }

  async importCollectionDataFromJson(data: string) {
    if (!data) {
      throw new Error('String is empty.');
    }

    try {
      return this.importCollectionData(JSON.parse(data));
    } catch (err) {
      debug.log('The file is invalid.', err);
      throw err;
    }
  }

  async importCollectionData(data: ExportCollectionState) {
    try {
      // Verify file's content
      if (!data) {
        throw new Error('Object is empty.');
      }
      if (!data.version || !data.type || data.type !== 'collection') {
        throw new Error('File is not a valid Altair collection file.');
      }

      const collections = this.remapCollectionIDsToCollectionList(data);
      for (let i = 0; i < collections.length; i++) {
        const collection = collections[i];
        await this.create(collection);
      }
    } catch (err) {
      debug.log('Something went wrong while importing the data.', err);
      throw err;
    }
  }

  importCollectionData$(data: ExportCollectionState) {
    return observableFrom(this.importCollectionData(data));
  }

  async handleImportedFile(files: FileList) {
    try {
      const dataStr = await getFileStr(files);
      return this.importCollectionDataFromJson(dataStr);
    } catch (error) {
      debug.log('There was an issue importing the file.', error);
    }
  }

  async getAll() {
    return this.storage.queryCollections.toArray();
  }

  async syncRemoteToLocal() {
    const timestampDiffOffset = 2 * 60 * 1000;
    if (!(await this.canApplyRemote())) {
      // not logged in
      return;
    }
    // https://learnsql.com/blog/do-it-in-sql-recursive-tree-traversal/
    // https://supabase.com/blog/2020/11/18/postgresql-views
    const serverCollections = await this.api.getCollections();
    // const { data: serverCollections } = await supabase
    //   .from('request_collections')
    //   .select('*, requests(*)');

    if (!serverCollections?.length) {
      return;
    }

    const localCollections = await this.getAll();

    for (const serverCollection of serverCollections) {
      const matchedCollection = localCollections.find(
        (collection) => collection.serverId === serverCollection.id
      );
      if (matchedCollection) {
        const serverDate = new Date(serverCollection.updatedAt);
        const localDate = new Date(matchedCollection.updated_at!);
        if (serverDate.getTime() > localDate.getTime() + timestampDiffOffset) {
          serverCollection.queries.forEach((serverQuery) => {
            // update collection queries
            matchedCollection.queries = matchedCollection.queries.map(
              (query) => {
                if (query.serverId === serverQuery.id) {
                  const serverRequestDate = new Date(serverQuery.updatedAt);
                  const localRequestDate = new Date(query.updated_at!);
                  if (
                    serverRequestDate.getTime() >
                    localRequestDate.getTime() + timestampDiffOffset
                  ) {
                    // TODO: if collection query is already open in the app, ask user and overwrite open query
                    // server content is newer
                    return {
                      ...serverQuery.content,
                      serverId: serverQuery.id,
                    };
                  }
                }
                return query;
              }
            );

            // TODO: Handle parentPath
            // matchedCollection.parentPath

            matchedCollection.title = serverCollection.collectionName;
          });
          // server content is newer
          if (matchedCollection.id) {
            await this.updateLocalCollection(
              matchedCollection.id,
              matchedCollection
            );
          }
        }
      } else {
        // add collection to local
        const queries = serverCollection.queries.map((serverQuery) => ({
          ...serverQuery.content,
          serverId: serverQuery.id,
        }));
        const localCollection: IQueryCollection = {
          title: serverCollection.collectionName,
          queries,
          serverId: serverCollection.id,
          // parentPath // TODO: Handle parentPath
        };

        await this.createLocalCollection(localCollection);
      }
    }
  }

  /**
   *
   * @param collectionId the parent collection ID
   * @param recursive determines if all the descendants (sub collections of sub collections) should be retrieved
   */
  async getSubcollections(
    collectionId: CollectionID,
    recursive = false
  ): Promise<IQueryCollection[]> {
    const parentPath = await this.getSubcollectionParentPath(collectionId);
    const whereClause = this.storage.queryCollections.where('parentPath');

    if (recursive) {
      return whereClause.startsWith(parentPath).toArray();
    }
    return whereClause.equals(parentPath).toArray();
  }

  getSubcollections$(collectionId: CollectionID, recursive = false) {
    observableFrom(this.getSubcollections(collectionId, recursive));
  }

  moveCollection(
    collectionId: CollectionID,
    newParentCollectionId: CollectionID
  ) {
    return this.moveLocalCollection(collectionId, newParentCollectionId);
    // TODO: move collection remote
  }

  /**
   * Moves a collection from its previous parent in the tree to a new parent collection
   * @param collectionId
   * @param newParentCollectionId
   */
  private async moveLocalCollection(
    collectionId: CollectionID,
    newParentCollectionId: CollectionID
  ) {
    return this.storage.transaction(
      'rw',
      this.storage.queryCollections,
      async () => {
        const collection = await this.getCollectionByID(collectionId);
        if (!collection) {
          throw new Error('Could not retrieve collection');
        }

        // '/coll-z', id: 456
        const newParentCollection = await this.getCollectionByID(
          newParentCollectionId
        );
        if (!newParentCollection) {
          throw new Error('Could not retrieve parent collection');
        }
        const newParentCollectionParentPath =
          newParentCollection.parentPath ?? '';
        const newParentSubcollectionParentPath = `${newParentCollectionParentPath}${COLLECTION_PATH_SEPARATOR}${newParentCollectionId}`;

        // '/coll-a'
        const collectionParentPath = collection.parentPath ?? '';
        // '/coll-a/123'
        const parentPath = `${collectionParentPath}${COLLECTION_PATH_SEPARATOR}${collectionId}`;

        // '/coll-a' -> '/coll-z/456'
        // '/coll-a/123' -> '/coll-z/456/123'
        return this.storage.queryCollections
          .where({ id: collectionId })
          .or('id')
          .equals(this.getAlternateCollectionID(collectionId)) // include the collection itself
          .or('parentPath')
          .startsWith(parentPath) // ...and its descendants
          .modify((c) => {
            c.parentPath = c.parentPath?.replace(
              collectionParentPath,
              newParentSubcollectionParentPath
            );
          });
      }
    );
  }

  getCollectionTrees(collections: IQueryCollection[]) {
    const roots: IQueryCollectionTree[] = [];
    const collectionMap = new Map<string, IQueryCollectionTree>();

    collections.forEach((collection) => {
      const collectionId = collection.id;
      if (!collectionId) {
        throw new Error('All collections must have an ID to get a tree!');
      }

      collectionMap.set(`${collectionId}`, {
        ...collection,
        id: `${collectionId}`,
        collections: [],
      });
    });

    collections.forEach((collection) => {
      const collectionTree = collectionMap.get(`${collection.id}`);
      if (!collectionTree) {
        return;
      }

      if (!collection.parentPath) {
        roots.push(collectionTree);
        return;
      }

      const parentCollectionId = this.getParentCollectionId(collection);
      if (!parentCollectionId) {
        roots.push(collectionTree);
        return;
      }

      const parentCollection = collectionMap.get(parentCollectionId);
      parentCollection?.collections?.push(collectionTree);
    });

    return roots;
  }

  getParentCollectionId(collection: IQueryCollection) {
    const id = collection.parentPath?.split(COLLECTION_PATH_SEPARATOR).pop();
    return id ? id : undefined;
  }

  getParentCollection(collection: IQueryCollection) {
    const parentCollectionId = this.getParentCollectionId(collection);
    if (parentCollectionId) {
      return this.getCollectionByID(parentCollectionId);
    }
  }

  async getAllParentCollections(collection: IQueryCollection) {
    const collections: IQueryCollection[] = [];
    let curCollection = collection;
    for (;;) {
      const parentCollection = await this.getParentCollection(curCollection);
      if (!parentCollection) {
        return collections;
      }

      collections.push(parentCollection);
      curCollection = parentCollection;
    }
  }

  getCollectionTree$(collections: IQueryCollection[]) {
    return of(this.getCollectionTrees(collections));
  }

  getCollectionListFromTree(
    tree: IQueryCollectionTree,
    parentPath = ''
  ): IQueryCollection[] {
    // remove collections and keep the rest as collection
    const { collections, ...rootCollection } = tree;
    const subcollections = collections?.map((ct) =>
      this.getCollectionListFromTree(
        ct,
        `${parentPath}${COLLECTION_PATH_SEPARATOR}${tree.id}`
      )
    );

    return [
      {
        ...rootCollection,
        parentPath, // set the parent path
      },
      ...(subcollections || []).flat(),
    ];
  }

  remapCollectionIDsToCollectionList(
    tree: IQueryCollectionTree,
    parentPath = ''
  ): IQueryCollection[] {
    // remove collections and keep the rest as collection
    const { collections, ...rootCollection } = tree;
    // re-assign a new ID to collection
    rootCollection.id = uuid();
    // pass new ID as parentPath in sub collections
    const subcollections = collections?.map((ct) =>
      this.remapCollectionIDsToCollectionList(
        ct,
        `${parentPath}${COLLECTION_PATH_SEPARATOR}${rootCollection.id}`
      )
    );

    return [
      {
        ...rootCollection,
        parentPath, // set the parent path
      },
      ...(subcollections || []).flat(),
    ];
  }

  async getCollectionTreeByCollectionId(collectionId: CollectionID) {
    const collection = await this.getCollectionByID(collectionId);
    if (!collection) {
      throw new Error('Collection not found!');
    }
    const subcollections = await this.getSubcollections(collectionId, true);

    const [collectionTree] = this.getCollectionTrees([
      collection,
      ...subcollections,
    ]);

    return collectionTree;
  }

  /**
   * Generate parentPath for subcollections of the specified parent collection
   * @param parentCollectionId
   */
  private async getSubcollectionParentPath(parentCollectionId: CollectionID) {
    const parentCollection = await this.getCollectionByID(parentCollectionId);
    const parentCollectionParentPath = parentCollection?.parentPath ?? '';

    return `${parentCollectionParentPath}${COLLECTION_PATH_SEPARATOR}${parentCollectionId}`;
  }
}
