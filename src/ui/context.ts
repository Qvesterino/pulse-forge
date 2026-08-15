import { createContext, useContext, useSyncExternalStore } from "react";
import type { Services } from "../services";
import type { ProjectDocument } from "../project-model/types";
import type { SaveStatus } from "../store/ProjectStore";

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("Services not initialized");
  return services;
}

export function useDoc(): ProjectDocument {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getDoc, store.getDoc);
}

export function useSaveStatus(): SaveStatus {
  const { store } = useServices();
  return useSyncExternalStore(store.subscribe, store.getSaveStatus, store.getSaveStatus);
}
