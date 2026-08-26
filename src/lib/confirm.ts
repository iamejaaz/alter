import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";

export async function confirmDialog(message: string, title = "Alter"): Promise<boolean> {
  try {
    return await tauriConfirm(message, { title, kind: "warning" });
  } catch {
    try {
      return window.confirm(message);
    } catch {
      return true;
    }
  }
}
