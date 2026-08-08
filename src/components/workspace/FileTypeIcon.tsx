import { getIcon } from "material-file-icons";

interface FileTypeIconProps {
  name: string;
}

/** File-type icon from the VS Code Material Icon Theme. */
export function FileTypeIcon({ name }: FileTypeIconProps) {
  // The bundled SVGs come with inline style="width:100%;height:100%", which
  // would override any CSS size rule and blow the icon up to fill its row.
  // Strip it and set explicit width/height attributes instead: attributes are
  // the SVG-native sizing and work even if the stylesheet fails to load
  // (CSS rules still take precedence when present).
  const svg = getIcon(name)
    .svg.replace('style="width:100%;height:100%"', "")
    .replace("<svg ", '<svg width="14" height="14" ');
  return <span className="tool-file-type-icon" dangerouslySetInnerHTML={{ __html: svg }} />;
}
