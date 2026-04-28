// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://vaultbase.dev",
  integrations: [
    starlight({
      title: "Vaultbase",
      description:
        "Self-hosted backend in a single binary — collections, REST API, auth, realtime, files, hooks. TypeScript on Bun.",
      logo: { src: "./public/favicon.svg" },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/vaultbase/vaultbase" },
      ],
      customCss: ["./src/styles/custom.css"],
      // Font preconnects — pairs with the @import at the top of custom.css so
      // the fetch starts as early as the browser can manage it.
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", link: "/" },
            { label: "Quick start", link: "/getting-started/quick-start/" },
            { label: "Installation", link: "/getting-started/installation/" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Collections", link: "/concepts/collections/" },
            { label: "Fields & validation", link: "/concepts/fields/" },
            { label: "API rules", link: "/concepts/rules/" },
            { label: "Authentication", link: "/concepts/authentication/" },
            { label: "Realtime", link: "/concepts/realtime/" },
            { label: "Files", link: "/concepts/files/" },
            { label: "Storage (S3 / R2)", link: "/concepts/storage/" },
            { label: "Encrypted fields", link: "/concepts/encryption/" },
            { label: "Hooks · routes · cron", link: "/concepts/hooks/" },
            { label: "Logging & rate limits", link: "/concepts/logging/" },
          ],
        },
        {
          label: "API Reference",
          items: [
            { label: "Authentication", link: "/api/authentication/" },
            { label: "OAuth2", link: "/api/oauth2/" },
            { label: "Records", link: "/api/records/" },
            { label: "Collections", link: "/api/collections/" },
            { label: "Files", link: "/api/files/" },
            { label: "Realtime (WS)", link: "/api/realtime/" },
            { label: "Batch", link: "/api/batch/" },
            { label: "Custom routes", link: "/api/custom-routes/" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Deployment", link: "/guides/deployment/" },
            { label: "Backups & migrations", link: "/guides/backups/" },
            { label: "CSV import / export", link: "/guides/csv/" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Settings keys", link: "/reference/settings/" },
            { label: "Field types", link: "/reference/field-types/" },
          ],
        },
      ],
      pagination: true,
    }),
  ],
});
