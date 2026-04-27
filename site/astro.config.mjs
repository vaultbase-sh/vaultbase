// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://vaultbase.dev",
  integrations: [
    starlight({
      title: "Vaultbase",
      description: "Self-hosted backend in a single binary — collections, REST API, auth, realtime, files, hooks. PocketBase-style, in TypeScript on Bun.",
      logo: { src: "./public/favicon.svg" },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/vaultbase/vaultbase" },
      ],
      customCss: ["./src/styles/custom.css"],
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
            { label: "Hooks · routes · cron", link: "/concepts/hooks/" },
          ],
        },
        {
          label: "API Reference",
          items: [
            { label: "Authentication", link: "/api/authentication/" },
            { label: "Records", link: "/api/records/" },
            { label: "Collections", link: "/api/collections/" },
            { label: "Files", link: "/api/files/" },
            { label: "Realtime (WS)", link: "/api/realtime/" },
            { label: "Batch", link: "/api/batch/" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Deployment", link: "/guides/deployment/" },
            { label: "Backups & migrations", link: "/guides/backups/" },
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
