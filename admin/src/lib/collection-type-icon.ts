/** The icon (components/Icon.tsx) for a collection type; unknown types get the base one. */
export function collectionTypeIcon(type: string | null | undefined): "colBase" | "colAuth" | "colView" | "colSingleton" {
  switch (type) {
    case "auth": return "colAuth";
    case "view": return "colView";
    case "singleton": return "colSingleton";
    default: return "colBase";
  }
}
