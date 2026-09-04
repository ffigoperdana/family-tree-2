import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";

import { ACCOUNT_SYNC_LOCK_NAME, loadAppData, saveAppData, saveSyncedState, type SyncMapping } from "./db";
import { publishActiveFamilyDebugContext } from "./debugContext";
import {
  addRelationship as addRelationshipToData,
  createInitialAppData,
  createPerson as createPersonInData,
  copyFocusedTree as copyFocusedTreeInData,
  createTree as createTreeInData,
  deletePerson as deletePersonFromData,
  deleteTree as deleteTreeFromData,
  removeRelationship as removeRelationshipFromData,
  renameTree as renameTreeInData,
  replaceAppData,
  selectPerson as selectPersonInData,
  selectTree as selectTreeInData,
  setLanguage as setLanguageInData,
  setRelationshipLanguage as setRelationshipLanguageInData,
  setViewport as setViewportInData,
  updatePerson as updatePersonInData,
  DomainError,
  type AppLanguage,
  type NewPersonInput,
  type PersonChanges
} from "./domain";
import { useAuth, type AuthUser } from "./auth";
import { allowsCoParent } from "./relationshipRoles";
import {
  CANONICAL_TREE_ID,
  createRemoteTree,
  deleteRemoteTree,
  fetchCanonicalTree,
  fetchWorkspace,
  updateRemoteTree,
  type RemoteTree
} from "./remoteData";
import { newId } from "./types";
import type { AppData, DirectRole, RelationshipLanguage, ViewportState } from "./types";

export interface RelationshipDraftInput {
  relativePersonId: string;
  role: DirectRole;
  marriageDate?: string;
  divorceDate?: string;
}

export interface AppActions {
  createTree(title: string): string;
  copyFocusedTree(
    sourceTreeId: string,
    title: string,
    focusPersonId: string
  ): string;
  renameTree(treeId: string, title: string): void;
  deleteTree(treeId: string): void;
  selectTree(treeId?: string): void;
  createPerson(treeId: string, input: NewPersonInput | string): string;
  createRelative(
    treeId: string,
    targetPersonId: string,
    input: NewPersonInput,
    role: DirectRole,
    marriageDate?: string,
    coParentId?: string,
    divorceDate?: string
  ): string;
  updatePerson(personId: string, changes: PersonChanges): void;
  savePerson(
    personId: string,
    changes: PersonChanges,
    removedRelationshipIds: readonly string[],
    additions: readonly RelationshipDraftInput[]
  ): void;
  deletePerson(personId: string): void;
  selectPerson(personId?: string): void;
  addRelationship(
    personId: string,
    relativePersonId: string,
    role: DirectRole,
    marriageDate?: string,
    divorceDate?: string
  ): string;
  linkRelative(
    targetPersonId: string,
    relativePersonId: string,
    role: DirectRole,
    marriageDate?: string,
    coParentId?: string,
    divorceDate?: string
  ): void;
  removeRelationship(relationshipId: string): void;
  setLanguage(language: AppLanguage): void;
  setRelationshipLanguage(language: RelationshipLanguage): void;
  setViewport(treeId: string, viewport: ViewportState): void;
  replaceData(data: unknown): void;
  importData(data: unknown): void;
  replaceDataPersisted(data: unknown, expectedDataFingerprint: string): Promise<boolean>;
  applySyncedData(data: unknown, expectedDataFingerprint: string, accountId: string, mappings: readonly SyncMapping[]): Promise<boolean>;
  prepareSyncData(): Promise<{ data: AppData; currentDataFingerprint: string }>;
  flushLocalSaves(): Promise<void>;
}

export interface AppStoreValue extends AppActions {
  data: AppData | null;
  state: AppData | null;
  isLoading: boolean;
  ready: boolean;
  error: Error | null;
  actions: AppActions;
}

const AppStoreContext = createContext<AppStoreValue | undefined>(undefined);

const asError = (value: unknown) =>
  value instanceof Error ? value : new Error("Unable to access local family data.");

export const syncTreeVersion = (data: AppData): string => data.trees
  .map((tree) => `${tree.id}:${tree.updatedAt}`)
  .sort()
  .join("|");

export const syncDataFingerprint = (data: AppData): string => JSON.stringify(data);

const validateCoParent = (
  data: AppData,
  targetPersonId: string,
  coParentId: string,
  role: DirectRole
) => {
  if (!allowsCoParent(role)) {
    throw new DomainError(
      "invalidData",
      data.language === "id"
        ? "Hubungan ini tidak dapat memiliki orang tua bersama."
        : "This relationship does not allow a co-parent."
    );
  }
  const target = data.people.find((person) => person.id === targetPersonId);
  if (!target) {
    throw new DomainError("notFound", "The target person does not exist.");
  }
  const coParent = data.people.find((person) => person.id === coParentId);
  const hasActiveUnion = data.relationships.some((relationship) =>
    relationship.treeId === target.treeId &&
    relationship.kind === "partner" &&
    (relationship.subtype === "partner" || relationship.subtype === "spouse") &&
    ((relationship.fromPersonId === targetPersonId && relationship.toPersonId === coParentId) ||
      (relationship.fromPersonId === coParentId && relationship.toPersonId === targetPersonId))
  );
  if (!coParent || coParent.treeId !== target.treeId || !hasActiveUnion) {
    throw new DomainError(
      "invalidData",
      data.language === "id"
        ? "Orang tua bersama harus merupakan pasangan aktif dalam silsilah yang sama."
        : "The selected co-parent must be a same-tree active partner or spouse of the target person."
    );
  }
};

const treeForData = (data: AppData, treeId: string) => data.trees.find((tree) => tree.id === treeId);

const treeDocument = (data: AppData, treeId: string): AppData => {
  const tree = treeForData(data, treeId);
  if (!tree) throw new DomainError("notFound");
  return {
    ...data,
    trees: [{ ...tree, lastSelectedPersonId: undefined }],
    people: data.people.filter((person) => person.treeId === treeId),
    relationships: data.relationships.filter((relationship) => relationship.treeId === treeId),
    selectedTreeId: treeId,
    viewports: data.viewports[treeId] ? { [treeId]: data.viewports[treeId] } : {}
  };
};

const treeFingerprint = (data: AppData, treeId: string) => {
  const document = treeDocument(data, treeId);
  return JSON.stringify({
    ...document,
    trees: document.trees.map((tree) => ({
      ...tree,
      kind: undefined,
      ownerId: undefined,
      revision: undefined,
      updatedAt: undefined
    })),
    viewports: {}
  });
};

const remoteDocumentToTree = (remote: RemoteTree): AppData => {
  const document = remote.document;
  const sourceTree = document.trees[0];
  const tree = {
    ...sourceTree,
    id: remote.treeId,
    title: remote.title,
    kind: remote.kind,
    ...(remote.ownerId ? { ownerId: remote.ownerId } : {}),
    revision: remote.revision
  };
  return {
    ...document,
    trees: [tree],
    people: document.people.filter((person) => person.treeId === remote.treeId),
    relationships: document.relationships.filter((relationship) => relationship.treeId === remote.treeId),
    selectedTreeId: remote.treeId,
    viewports: document.viewports[remote.treeId] ? { [remote.treeId]: document.viewports[remote.treeId] } : {}
  };
};

const mergeRemoteWorkspace = (
  remoteTrees: readonly RemoteTree[],
  previous: AppData | null
): AppData => {
  const documents = remoteTrees.map(remoteDocumentToTree);
  const canonical = documents.find((document) => document.trees[0]?.kind === "canonical") ?? documents[0];
  if (!canonical) throw new Error("The canonical family tree is unavailable.");
  const treeIds = new Set(documents.flatMap((document) => document.trees.map((tree) => tree.id)));
  const selectedTreeId = previous?.selectedTreeId && treeIds.has(previous.selectedTreeId)
    ? previous.selectedTreeId
    : canonical.trees[0].id;
  return {
    ...canonical,
    trees: documents.flatMap((document) => document.trees),
    people: documents.flatMap((document) => document.people),
    relationships: documents.flatMap((document) => document.relationships),
    selectedTreeId,
    language: previous?.language ?? canonical.language,
    relationshipLanguage: previous?.relationshipLanguage ?? canonical.relationshipLanguage,
    relationshipTerminology: previous?.relationshipTerminology ?? canonical.relationshipTerminology,
    viewports: Object.fromEntries(documents.flatMap((document) => Object.entries(document.viewports)))
  };
};

const canonicalFallback = (): AppData => {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    trees: [{
      id: CANONICAL_TREE_ID,
      title: "Keluarga Haji Soenarto",
      createdAt: timestamp,
      updatedAt: timestamp,
      kind: "canonical",
      revision: 0
    }],
    people: [],
    relationships: [],
    selectedTreeId: CANONICAL_TREE_ID,
    language: "id",
    relationshipLanguage: "id",
    relationshipTerminology: "id",
    viewports: {}
  };
};

const addRemoteMetadata = (data: AppData, user: AuthUser | undefined): AppData => {
  if (!user) return data;
  let changed = false;
  const trees = data.trees.map((tree) => {
    if (tree.id === CANONICAL_TREE_ID) {
      if (tree.kind === "canonical" && tree.ownerId === undefined) return tree;
      changed = true;
      return { ...tree, kind: "canonical" as const, ownerId: undefined };
    }
    if (tree.kind === "personal" && tree.ownerId === user.id) return tree;
    changed = true;
    return { ...tree, kind: "personal" as const, ownerId: user.id };
  });
  return changed ? { ...data, trees } : data;
};

const canEditTree = (tree: { id: string; kind?: "canonical" | "personal"; ownerId?: string }, user: AuthUser | undefined, enabled: boolean) => {
  if (!enabled) return true;
  if (!user) return false;
  return tree.kind === "canonical" ? user.role === "admin" : tree.ownerId === user.id;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [data, setData] = useState<AppData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [remoteLoading, setRemoteLoading] = useState(auth.enabled);
  const [error, setError] = useState<Error | null>(null);
  const dataRef = useRef<AppData | null>(null);
  const mountedRef = useRef(false);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveErrorRef = useRef<Error | undefined>(undefined);
  const persistedFingerprintRef = useRef<string | undefined>(undefined);
  const queuedFingerprintRef = useRef<string | undefined>(undefined);
  const deferredSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const skipNextAutomaticSaveRef = useRef(false);
  const skipAutomaticSaveDataRef = useRef<AppData | undefined>(undefined);
  const remoteIdentityRef = useRef<string | undefined>(auth.enabled ? undefined : "local");
  const remoteAvailableRef = useRef(false);
  const remoteFingerprintsRef = useRef(new Map<string, string>());
  const remoteRevisionsRef = useRef(new Map<string, number>());
  const remotePendingRef = useRef(new Set<string>());
  const remoteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const remoteIdentity = auth.enabled
    ? auth.loading
      ? undefined
      : auth.user?.id ?? "anonymous"
    : "local";

  const assertCanEdit = (current: AppData, treeId: string) => {
    const tree = treeForData(current, treeId);
    if (!tree || !canEditTree(tree, auth.user, auth.enabled)) {
      throw new DomainError("invalidData", "You do not have permission to edit this family tree.");
    }
  };

  const tagRemoteData = (current: AppData) => addRemoteMetadata(current, auth.user);

  const assertCanReplace = (current: AppData, replacement: AppData) => {
    if (!auth.enabled) return;
    if (!auth.user) {
      throw new DomainError("invalidData", "Sign in before changing family data.");
    }
    for (const tree of replacement.trees) {
      const previous = treeForData(current, tree.id);
      const canonical = tree.id === CANONICAL_TREE_ID || previous?.kind === "canonical" || tree.kind === "canonical";
      if (canonical) {
        assertCanEdit(current, CANONICAL_TREE_ID);
      } else if (tree.ownerId !== auth.user.id) {
        throw new DomainError("invalidData", "You can only change family trees owned by your account.");
      }
    }
  };

  const queueSave = (next: AppData) => {
    const expectedFingerprint = queuedFingerprintRef.current;
    const nextFingerprint = syncDataFingerprint(next);
    queuedFingerprintRef.current = nextFingerprint;
    const persisted = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const persist = async () => {
          const stored = await loadAppData();
          const storedFingerprint = stored ? syncDataFingerprint(stored) : undefined;
          if (storedFingerprint !== expectedFingerprint && storedFingerprint !== persistedFingerprintRef.current) {
            throw new Error("Family data changed in another tab. Reload before continuing.");
          }
          await saveAppData(next);
          persistedFingerprintRef.current = nextFingerprint;
        };
        if (navigator.locks) await navigator.locks.request(ACCOUNT_SYNC_LOCK_NAME, persist);
        else await persist();
        saveErrorRef.current = undefined;
      });
    saveQueueRef.current = persisted.catch((reason: unknown) => {
      const nextError = asError(reason);
      saveErrorRef.current = nextError;
      if (mountedRef.current) setError(nextError);
    });
    return persisted;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void loadAppData()
      .then((stored) => {
        if (!active) return;
        const next = stored ? replaceAppData(stored) : createInitialAppData();
        persistedFingerprintRef.current = stored ? syncDataFingerprint(next) : undefined;
        queuedFingerprintRef.current = persistedFingerprintRef.current;
        dataRef.current = next;
        setData(next);
        setIsLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(asError(reason));
        setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!auth.enabled) {
      remoteAvailableRef.current = false;
      remoteIdentityRef.current = "local";
      setRemoteLoading(false);
      return;
    }
    if (auth.loading || isLoading || !data || !remoteIdentity || remoteIdentityRef.current === remoteIdentity) return;
    let active = true;
    setRemoteLoading(true);
    void (async () => {
      try {
        const remote = auth.user ? await fetchWorkspace() : await fetchCanonicalTree();
        const remoteTrees: RemoteTree[] = "trees" in remote
          ? [remote.canonical, ...remote.trees].filter((tree): tree is RemoteTree => Boolean(tree))
          : [remote];
        const next = mergeRemoteWorkspace(remoteTrees, dataRef.current ?? data);
        if (!active) return;
        remoteFingerprintsRef.current = new Map(remoteTrees.map((tree) => [
          tree.treeId,
          treeFingerprint(remoteDocumentToTree(tree), tree.treeId)
        ]));
        remoteRevisionsRef.current = new Map(remoteTrees.map((tree) => [tree.treeId, tree.revision]));
        remoteAvailableRef.current = true;
        dataRef.current = next;
        setData(next);
        remoteIdentityRef.current = remoteIdentity;
      } catch (reason) {
        if (!active) return;
        remoteAvailableRef.current = false;
        if (!auth.user) {
          const fallback = canonicalFallback();
          dataRef.current = fallback;
          setData(fallback);
        }
        console.warn("Unable to load the remote family workspace.", reason);
        remoteIdentityRef.current = remoteIdentity;
      } finally {
        if (active) setRemoteLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [auth.enabled, auth.loading, auth.user, data, isLoading, remoteIdentity]);

  useEffect(() => {
    if (isLoading || remoteLoading || !data) return;
    if (skipAutomaticSaveDataRef.current) {
      const skip = skipAutomaticSaveDataRef.current === data;
      skipAutomaticSaveDataRef.current = undefined;
      if (skip) return;
    }
    if (skipNextAutomaticSaveRef.current) {
      skipNextAutomaticSaveRef.current = false;
      return;
    }
    if (deferredSaveTimerRef.current) {
      clearTimeout(deferredSaveTimerRef.current);
      deferredSaveTimerRef.current = undefined;
    }
    queueSave(dataRef.current ?? data);
  }, [data, isLoading, remoteLoading]);

  useEffect(() => {
    if (isLoading || remoteLoading || !data || !__DEBUG_CONTEXT_ENABLED__) return;
    void publishActiveFamilyDebugContext(data).catch((reason: unknown) => {
      console.warn("Unable to update the local family debug context.", reason);
    });
  }, [data, isLoading, remoteLoading]);

  useEffect(() => {
    if (!auth.enabled || auth.loading || remoteLoading || !data || !auth.user || !auth.csrfToken ||
        !remoteAvailableRef.current || remoteIdentityRef.current !== auth.user.id) return;
    const user = auth.user;
    const csrfToken = auth.csrfToken;
    const known = remoteFingerprintsRef.current;
    const revisions = remoteRevisionsRef.current;
    const currentIds = new Set(data.trees.map((tree) => tree.id));

    const enqueue = (treeId: string, deleted: boolean) => {
      if (remotePendingRef.current.has(treeId)) return;
      remotePendingRef.current.add(treeId);
      remoteQueueRef.current = remoteQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const current = dataRef.current;
          const tree = current ? treeForData(current, treeId) : undefined;
          if (deleted) {
            if (tree || treeId === CANONICAL_TREE_ID) return;
            await deleteRemoteTree(treeId, csrfToken);
            known.delete(treeId);
            revisions.delete(treeId);
            return;
          }
          if (!current || !tree || !canEditTree(tree, user, true)) return;
          const document = treeDocument(current, treeId);
          const result = known.has(treeId)
            ? await updateRemoteTree(treeId, document, revisions.get(treeId) ?? tree.revision ?? 0, csrfToken)
            : await createRemoteTree(document, csrfToken);
          known.set(treeId, treeFingerprint(remoteDocumentToTree(result), treeId));
          revisions.set(treeId, result.revision);
        })
        .catch((reason: unknown) => {
          if (mountedRef.current) setError(asError(reason));
        })
        .finally(() => {
          remotePendingRef.current.delete(treeId);
        });
    };

    for (const tree of data.trees) {
      if (!canEditTree(tree, user, true)) continue;
      const fingerprint = treeFingerprint(data, tree.id);
      if (known.get(tree.id) !== fingerprint) enqueue(tree.id, false);
    }
    for (const treeId of known.keys()) {
      if (!currentIds.has(treeId) && treeId !== CANONICAL_TREE_ID) enqueue(treeId, true);
    }
  }, [auth.csrfToken, auth.enabled, auth.loading, auth.user, data, remoteLoading]);

  function commit<T>(change: (current: AppData) => [AppData, T]): T {
    const current = dataRef.current;
    if (!current) throw new Error("The family data store is not ready.");
    const [changed, result] = change(current);
    const next = tagRemoteData(changed);
    if (next !== current) {
      dataRef.current = next;
      setData(next);
    }
    return result;
  }

  function createTree(title: string) {
    if (auth.enabled && !auth.user) {
      throw new DomainError("invalidData", "Sign in before creating a family tree.");
    }
    const id = newId();
    return commit((current) => [
      createTreeInData(current, title, { id }),
      id
    ]);
  }

  function copyFocusedTree(
    sourceTreeId: string,
    title: string,
    focusPersonId: string
  ) {
    if (auth.enabled && !auth.user) {
      throw new DomainError("invalidData", "Sign in before creating a family tree.");
    }
    return commit((current) => {
      const result = copyFocusedTreeInData(current, sourceTreeId, {
        title,
        focusPersonId
      });
      return [result.data, result.treeId];
    });
  }

  function renameTree(treeId: string, title: string) {
    commit((current) => {
      assertCanEdit(current, treeId);
      return [renameTreeInData(current, treeId, title), undefined];
    });
  }

  function deleteTree(treeId: string) {
    commit((current) => {
      const tree = treeForData(current, treeId);
      if (!tree || tree.id === CANONICAL_TREE_ID || tree.kind === "canonical") {
        throw new DomainError("invalidData", "The Keluarga Haji Soenarto tree cannot be deleted.");
      }
      assertCanEdit(current, treeId);
      return [deleteTreeFromData(current, treeId), undefined];
    });
  }

  function selectTree(treeId?: string) {
    commit((current) => [selectTreeInData(current, treeId), undefined]);
  }

  function createPerson(treeId: string, input: NewPersonInput | string) {
    const id = newId();
    const personInput = typeof input === "string" ? { displayName: input } : input;
    return commit((current) => {
      assertCanEdit(current, treeId);
      return [createPersonInData(current, treeId, personInput, { id }), id];
    });
  }

  function createRelative(
    treeId: string,
    targetPersonId: string,
    input: NewPersonInput,
    role: DirectRole,
    marriageDate?: string,
    coParentId?: string,
    divorceDate?: string
  ) {
    const personId = newId();
    const relationshipId = newId();
    const coParentRelationshipId = coParentId === undefined ? undefined : newId();
    return commit((current) => {
      assertCanEdit(current, treeId);
      if (coParentId !== undefined) {
        validateCoParent(current, targetPersonId, coParentId, role);
      }
      let next = createPersonInData(
        current,
        treeId,
        { ...input, role },
        { id: personId }
      );
      next = addRelationshipToData(
        next,
        targetPersonId,
        personId,
        role,
        marriageDate,
        { id: relationshipId },
        divorceDate
      );
      if (coParentId !== undefined && coParentRelationshipId) {
        next = addRelationshipToData(
          next,
          coParentId,
          personId,
          role,
          undefined,
          { id: coParentRelationshipId }
        );
      }
      return [next, personId];
    });
  }

  function updatePerson(personId: string, changes: PersonChanges) {
    commit((current) => {
      const person = current.people.find((item) => item.id === personId);
      assertCanEdit(current, person?.treeId ?? "");
      return [updatePersonInData(current, personId, changes), undefined];
    });
  }

  function savePerson(
    personId: string,
    changes: PersonChanges,
    removedRelationshipIds: readonly string[],
    additions: readonly RelationshipDraftInput[]
  ) {
    const relationshipIds = additions.map(() => newId());
    commit((current) => {
      const person = current.people.find((item) => item.id === personId);
      assertCanEdit(current, person?.treeId ?? "");
      let next = updatePersonInData(current, personId, changes);
      for (const relationshipId of removedRelationshipIds) {
        next = removeRelationshipFromData(next, relationshipId);
      }
      additions.forEach((addition, index) => {
        next = addRelationshipToData(
          next,
          personId,
          addition.relativePersonId,
          addition.role,
          addition.marriageDate,
          { id: relationshipIds[index] },
          addition.divorceDate
        );
      });
      return [next, undefined];
    });
  }

  function deletePerson(personId: string) {
    commit((current) => {
      const person = current.people.find((item) => item.id === personId);
      assertCanEdit(current, person?.treeId ?? "");
      return [deletePersonFromData(current, personId), undefined];
    });
  }

  function selectPerson(personId?: string) {
    const current = dataRef.current;
    if (!current) throw new Error("The family data store is not ready.");
    const next = selectPersonInData(current, personId);
    if (next === current) return;
    dataRef.current = next;
    skipNextAutomaticSaveRef.current = true;
    setData(next);
    if (deferredSaveTimerRef.current) clearTimeout(deferredSaveTimerRef.current);
    deferredSaveTimerRef.current = setTimeout(() => {
      deferredSaveTimerRef.current = undefined;
      const latest = dataRef.current;
      if (latest) queueSave(latest);
    }, 800);
  }

  function addRelationship(
    personId: string,
    relativePersonId: string,
    role: DirectRole,
    marriageDate?: string,
    divorceDate?: string
  ) {
    const id = newId();
    return commit((current) => {
      const person = current.people.find((item) => item.id === personId);
      assertCanEdit(current, person?.treeId ?? "");
      return [addRelationshipToData(current, personId, relativePersonId, role, marriageDate, { id }, divorceDate), id];
    });
  }

  function linkRelative(
    targetPersonId: string,
    relativePersonId: string,
    role: DirectRole,
    marriageDate?: string,
    coParentId?: string,
    divorceDate?: string
  ) {
    const relationshipId = newId();
    const coParentRelationshipId = coParentId === undefined ? undefined : newId();
    commit((current) => {
      const target = current.people.find((item) => item.id === targetPersonId);
      assertCanEdit(current, target?.treeId ?? "");
      if (coParentId !== undefined) {
        validateCoParent(current, targetPersonId, coParentId, role);
      }
      let next = addRelationshipToData(
        current,
        targetPersonId,
        relativePersonId,
        role,
        marriageDate,
        { id: relationshipId },
        divorceDate
      );
      if (coParentId !== undefined && coParentRelationshipId) {
        next = addRelationshipToData(
          next,
          coParentId,
          relativePersonId,
          role,
          undefined,
          { id: coParentRelationshipId }
        );
      }
      return [next, undefined];
    });
  }

  function removeRelationship(relationshipId: string) {
    commit((current) => {
      const relationship = current.relationships.find((item) => item.id === relationshipId);
      assertCanEdit(current, relationship?.treeId ?? "");
      return [removeRelationshipFromData(current, relationshipId), undefined];
    });
  }

  function setLanguage(language: AppLanguage) {
    commit((current) => [setLanguageInData(current, language), undefined]);
  }

  function setRelationshipLanguage(language: RelationshipLanguage) {
    commit((current) => [setRelationshipLanguageInData(current, language), undefined]);
  }

  function setViewport(treeId: string, viewport: ViewportState) {
    const current = dataRef.current;
    if (!current) throw new Error("The family data store is not ready.");
    const next = setViewportInData(current, treeId, viewport);
    if (next === current) return;
    dataRef.current = next;
    queueSave(next);
  }

  function replaceData(replacement: unknown) {
    const next = tagRemoteData(replaceAppData(replacement));
    commit((current) => {
      assertCanReplace(current, next);
      return [next, undefined];
    });
  }

  async function replaceDataPersisted(replacement: unknown, expectedDataFingerprint: string) {
    const current = dataRef.current;
    if (!current || syncDataFingerprint(current) !== expectedDataFingerprint) return false;
    const next = tagRemoteData(replaceAppData(replacement));
    if (auth.enabled && auth.user) assertCanReplace(current, next);
    skipAutomaticSaveDataRef.current = next;
    dataRef.current = next;
    setData(next);
    try {
      await queueSave(next);
    } catch (cause) {
      if (dataRef.current === next) {
        dataRef.current = current;
        setData(current);
      }
      throw cause;
    }
    return true;
  }

  async function applySyncedData(replacement: unknown, expectedDataFingerprint: string, accountId: string, mappings: readonly SyncMapping[]) {
    const current = dataRef.current;
    if (!current || syncDataFingerprint(current) !== expectedDataFingerprint) return false;
    const next = replaceAppData(replacement);
    const previousFingerprint = persistedFingerprintRef.current;
    const previousQueuedFingerprint = queuedFingerprintRef.current;
    persistedFingerprintRef.current = syncDataFingerprint(next);
    queuedFingerprintRef.current = persistedFingerprintRef.current;
    skipAutomaticSaveDataRef.current = next;
    dataRef.current = next;
    setData(next);
    try {
      await saveSyncedState(accountId, next, mappings);
    } catch (cause) {
      persistedFingerprintRef.current = previousFingerprint;
      if (dataRef.current === next) {
        queuedFingerprintRef.current = previousQueuedFingerprint;
        dataRef.current = current;
        setData(current);
      }
      throw cause;
    }
    return true;
  }

  async function prepareSyncData() {
    const current = dataRef.current;
    if (!current) throw new Error("The family data store is not ready.");
    const stored = await loadAppData();
    return {
      data: stored ? replaceAppData(stored) : current,
      currentDataFingerprint: syncDataFingerprint(dataRef.current ?? current)
    };
  }

  async function flushLocalSaves() {
    await saveQueueRef.current;
    if (saveErrorRef.current) throw saveErrorRef.current;
  }

  const actions: AppActions = {
    createTree,
    copyFocusedTree,
    renameTree,
    deleteTree,
    selectTree,
    createPerson,
    createRelative,
    updatePerson,
    savePerson,
    deletePerson,
    selectPerson,
    addRelationship,
    linkRelative,
    removeRelationship,
    setLanguage,
    setRelationshipLanguage,
    setViewport,
    replaceData,
    importData: replaceData,
    replaceDataPersisted,
    applySyncedData,
    prepareSyncData,
    flushLocalSaves
  };
  const value: AppStoreValue = {
    data,
    state: data,
    isLoading: isLoading || (auth.enabled && (auth.loading || remoteLoading)),
    ready: !isLoading && !remoteLoading && !auth.loading && data !== null,
    error,
    actions,
    ...actions
  };

  return (
    <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>
  );
}

export function useAppStore() {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error("useAppStore must be used inside AppProvider.");
  return store;
}

export const useApp = useAppStore;
