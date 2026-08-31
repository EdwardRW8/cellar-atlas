/** Stable per-device identity, used to attribute operations and events. */
const KEY = "cellar_v3_device";

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = `dev_${crypto.randomUUID().slice(0, 12)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "dev_ephemeral";
  }
}

export function newId(): string {
  return crypto.randomUUID();
}
