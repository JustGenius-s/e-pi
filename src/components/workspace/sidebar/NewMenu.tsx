import { FilePlus, FolderGit2, FolderPlus } from "lucide-react";

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";

/** Menu items shared by the group-header action and the collapsed-mode button. */
export function NewMenu({
  onNewSession,
  onNewProject,
  onImportProject,
}: {
  onNewSession: () => void;
  onNewProject: () => void;
  onImportProject: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onNewSession}>
        <FilePlus size={14} />
        <span>New session</span>
        <DropdownMenuShortcut>Home</DropdownMenuShortcut>
      </DropdownMenuItem>
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
