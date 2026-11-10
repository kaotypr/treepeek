import { type BrowserWindow, dialog } from "electron";
import { testDialogAnswers } from "./test-hooks";

/** Shows a native open dialog (a sheet on `parent` when there is one); the chosen path, or `null`. */
export type OpenDialog = (
  parent: BrowserWindow | null,
  options: Electron.OpenDialogOptions,
) => Promise<string | null>;

const nativeOpenDialog: OpenDialog = async (parent, options) => {
  const result =
    parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
};

/** The native dialog, or the end-to-end hook's answers when a test run set them. */
export function openDialog(): OpenDialog {
  const answers = testDialogAnswers();
  if (answers === null) return nativeOpenDialog;
  return async () => answers();
}
