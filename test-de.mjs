import "fake-indexeddb/auto";

async function main() {
  const req = indexedDB.open("test-db", 1);
  const db = await new Promise((resolve, reject) => {
    req.onupgradeneeded = () => {
      req.result.createObjectStore("test", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // First put
  const tx1 = db.transaction("test", "readwrite");
  tx1.objectStore("test").add({ id: "a", val: 1 });
  await new Promise((resolve, reject) => {
    tx1.oncomplete = resolve;
    tx1.onerror = () => reject(tx1.error);
  });
  console.log("first add succeeded");

  // Second add — should throw ConstraintError
  const tx2 = db.transaction("test", "readwrite");
  const addReq = tx2.objectStore("test").add({ id: "a", val: 2 });
  addReq.onerror = () => console.log("add onerror:", addReq.error?.name, addReq.error?.constructor?.name);
  addReq.onsuccess = () => console.log("add onsuccess");
  try {
    await new Promise((resolve, reject) => {
      tx2.oncomplete = () => { console.log("tx2.oncomplete"); resolve(); };
      tx2.onerror = () => reject(tx2.error);
      tx2.onabort = () => { console.log("tx2.onabort:", tx2.error?.name); reject(tx2.error); };
    });
  } catch (e) {
    console.log("caught from tx2:", e?.constructor?.name, e?.name, e instanceof Error);
  }

  // Third — put (should overwrite)
  const tx3 = db.transaction("test", "readwrite");
  const putReq = tx3.objectStore("test").put({ id: "a", val: 3 });
  putReq.onerror = () => console.log("put onerror:", putReq.error?.name, putReq.error?.constructor?.name);
  putReq.onsuccess = () => console.log("put onsuccess");
  try {
    await new Promise((resolve, reject) => {
      tx3.oncomplete = () => { console.log("tx3.oncomplete"); resolve(); };
      tx3.onerror = () => reject(tx3.error);
      tx3.onabort = () => { console.log("tx3.onabort:", tx3.error?.name); reject(tx3.error); };
    });
  } catch (e) {
    console.log("caught from tx3:", e?.constructor?.name, e?.name, e instanceof Error);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
