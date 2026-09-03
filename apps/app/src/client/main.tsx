import "@workspace/ui/globals.css";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./components/theme-provider.tsx";
import { queryClient } from "./lib/query.ts";
import { routeTree } from "./routeTree.gen.ts";

// `queryClient` を文脈に渡すのは `_authed.tsx` の gate が beforeLoad から
// クエリを引くため（コンポーネントの外なので hooks が使えない）。
const router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement === null) {
  // index.html と食い違ったときに「白い画面」ではなく理由を出す。
  throw new Error("#root が index.html に見つかりません");
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </StrictMode>,
);
