import { Menu } from "@base-ui/react/menu";
import { shortcutLabel } from "../../commands/keymap";
import { type CommandId, isCommandEnabled, runCommand } from "../../commands/registry";
import { ChevronIcon } from "../../components/icons";

const ITEMS: readonly (readonly [CommandId, string] | "separator")[] = [
  ["checkout.openInEditor", "Open in Editor"],
  ["checkout.openInTerminal", "Open in Terminal"],
  ["checkout.revealInFinder", "Reveal in Finder"],
  "separator",
  ["checkout.copyPath", "Copy Path"],
  ["checkout.copyBranch", "Copy Branch"],
  ["checkout.copyCommit", "Copy Commit"],
];

/**
 * "Open in ▾" for the selected checkout: editor, terminal, Finder, and copying its path,
 * branch or full commit id. Each item runs the same command as its shortcut and the
 * Checkout menu.
 */
export function OpenInMenu() {
  return (
    <Menu.Root>
      <Menu.Trigger
        className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2 py-0.5 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-hover"
        data-testid="open-in-button"
      >
        Open in
        <ChevronIcon className="size-3 rotate-90" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
          <Menu.Popup
            className="min-w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground text-xs shadow-lg outline-none"
            data-testid="open-in-menu"
          >
            <OpenInItems />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Rendered each time the menu opens, so what is enabled is current. */
function OpenInItems() {
  return ITEMS.map((item, index) =>
    item === "separator" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed
      <Menu.Separator key={index} className="my-1 h-px bg-border" />
    ) : (
      <Menu.Item
        key={item[0]}
        disabled={!isCommandEnabled(item[0])}
        onClick={() => runCommand(item[0])}
        className="flex cursor-default items-center gap-4 rounded-md px-2 py-1 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-selection data-[highlighted]:text-selection-foreground"
        data-command={item[0]}
      >
        <span className="flex-1">{item[1]}</span>
        {shortcutLabel(item[0]) && (
          <kbd className="font-sans opacity-70">{shortcutLabel(item[0])}</kbd>
        )}
      </Menu.Item>
    ),
  );
}
