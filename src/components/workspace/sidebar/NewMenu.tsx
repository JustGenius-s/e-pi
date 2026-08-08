import { FolderGit2, FolderPlus } from "lucide-react";

import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from "@/components/ui/dropdown-menu";

/**
 * Menu items for the Sessions group-header "+". "New session" is NOT here:
 * the sidebar has a dedicated one-click New session button below Packages, so
 * the menu only offers the actions that button can't do.
 */
export function NewMenu({
  onNewProject,
  onImportProject,
}: {
  onNewProject: () => void;
  onImportProject: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onNewProject}>
        <FolderPlus size={14} />
        <span>New project</span>
        <DropdownMenuShortcut>Choose folder</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onImportProject}>
        <FolderGit2 size={14} />
        <span>Import multi-repo project</span>
      </DropdownMenuItem>
    </>
  );
}
