import { createProducerMemoryEventId } from "./producer-memory-core";

/** A page-lifetime interaction id; it contains no project or prompt data. */
const SESSION_ID = `session-${createProducerMemoryEventId()}`;

export function currentProducerMemorySessionId(): string {
  return SESSION_ID;
}
