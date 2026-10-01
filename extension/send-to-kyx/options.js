const input = document.getElementById("intakeUrl");
const status = document.getElementById("status");

chrome.storage.local.get("intakeUrl").then(({ intakeUrl }) => {
  input.value = intakeUrl || "http://127.0.0.1:1234/api/intake";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ intakeUrl: input.value.trim() });
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
});
