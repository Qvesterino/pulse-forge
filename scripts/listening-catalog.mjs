import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function sessionDate(id) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(id);
  return match ? `${match[1]} · ${match[2]}:${match[3]} UTC` : null;
}

function guideMetadata(guide) {
  const heading = /^#\s+(.+)$/m.exec(guide)?.[1]?.trim();
  const genre = /Genre:\s*\*\*([^*]+)\*\*/i.exec(guide)?.[1]?.trim();
  const mode = /Mode:\s*\*\*([^*]+)\*\*/i.exec(guide)?.[1]?.trim();
  return { heading, genre, mode };
}

async function listSessions(listeningRoot, directory, kind) {
  const sessionsRoot = path.join(listeningRoot, directory);
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionRoot = path.join(sessionsRoot, entry.name);
    const [files, hasPage] = await Promise.all([
      readdir(sessionRoot, { withFileTypes: true }).catch(() => []),
      isFile(path.join(sessionRoot, "index.html")),
    ]);
    if (!hasPage) continue;

    const audioCount = files.filter((file) => file.isFile() && path.extname(file.name).toLowerCase() === ".wav").length;
    const pairCount = Math.floor(audioCount / 2);
    if (pairCount === 0) continue;

    let guide = "";
    try {
      guide = await readFile(path.join(sessionRoot, "LISTENING.md"), "utf8");
    } catch {
      // A generated player can still be listed when its optional guide is absent.
    }
    const metadata = guideMetadata(guide);
    sessions.push({
      id: entry.name,
      kind,
      title:
        metadata.heading ?? (kind === "song" ? "Producer DNA — whole-song comparison" : "Producer DNA listening pack"),
      genre: metadata.genre ?? null,
      mode: metadata.mode ?? null,
      pairCount,
      audioCount,
      date: sessionDate(entry.name),
      url: `/${directory}/${encodeURIComponent(entry.name)}/index.html`,
      verdictsSaved: await isFile(path.join(sessionRoot, "verdicts.json")),
    });
  }

  return sessions.sort((a, b) => b.id.localeCompare(a.id));
}

/** Build the small, read-only catalogue shown at the local Listening Inbox. */
export async function buildListeningCatalog(root) {
  const listeningRoot = path.join(root, "listening");
  const room = await readJson(path.join(listeningRoot, "room", "room.json"));
  const laneManifest = await readJson(path.join(listeningRoot, "lanes", "lanes.json"));
  const abxManifest = await readJson(path.join(listeningRoot, "abx", "lanes.json"));
  const roomAvailable = await isFile(path.join(listeningRoot, "room", "room.html"));
  const abxAvailable = await isFile(path.join(listeningRoot, "abx", "index.html"));
  const laneEntries = Array.isArray(laneManifest?.lanes) ? laneManifest.lanes : [];
  const abxLanes = Array.isArray(abxManifest?.lanes) ? abxManifest.lanes : [];

  return {
    room: {
      available: roomAvailable,
      url: "/room/",
      generatedAt: typeof room?.generatedAt === "string" ? room.generatedAt : null,
      lanes: new Set(laneEntries.map((lane) => lane?.id).filter((id) => typeof id === "string")).size,
      suites: {
        morph: Array.isArray(room?.morph) ? room.morph.length : 0,
        scenes: Array.isArray(room?.scenes) ? room.scenes.length : 0,
        intent: Array.isArray(room?.intent) ? room.intent.length : 0,
        conditioning: Array.isArray(room?.conditioning) ? room.conditioning.length : 0,
        grooves: Array.isArray(room?.grooves) ? room.grooves.length : 0,
      },
    },
    abx: {
      available: abxAvailable,
      url: "/abx/",
      lanes: abxLanes.length,
    },
    producerDna: await listSessions(listeningRoot, "producer-dna", "groove-hook"),
    producerDnaSongs: await listSessions(listeningRoot, "producer-dna-songs", "song"),
  };
}
