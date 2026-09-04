import { RunListQuery } from "@offdesk/contract";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

/*
  画面のテストの土台。

  **本物のルートファイル（`routes/_authed/runs/index.tsx`）は読み込まない。**
  あれは `_authed` の `beforeLoad` で `/rpc/me` を叩き、loader で oRPC を叩くので、
  描画を見るために通信を全部差し替えることになる ——
  **描くところは props だけを受ける部品に切ってある**ので、
  ここでは「その部品を router の中に置く」ことだけをする。

  router が要るのは `<Link>` のため（router の context 無しでは組めない）。
  行き先は本物と同じ 2 本（`/runs` と `/runs/$runKey`）にしてあるので、
  **`to` の綴りを間違えたリンクはここで href が組めずに落ちる。**
*/

const READY = "route-ready";

const buildRouter = (input: {
  readonly initialEntry: string;
  readonly component: () => ReactNode;
}) => {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });

  const runsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/runs",
    // **本物と同じスキーマ**（計画 P7a §3-4）。既定値への倒れ方もここで再現する。
    validateSearch: RunListQuery,
    component: () => <div data-testid={READY}>{input.component()}</div>,
  });

  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/runs/$runKey",
    component: () => <div data-testid={READY}>run detail</div>,
  });

  return {
    router: createRouter({
      routeTree: rootRoute.addChildren([runsRoute, detailRoute]),
      history: createMemoryHistory({ initialEntries: [input.initialEntry] }),
    }),
    runsRoute,
  };
};

/** `/runs` の search を検証済みの形で受け取り、それを使って描く。 */
export const renderWithSearch = async (input: {
  readonly initialEntry: string;
  readonly render: (search: RunListQuery) => ReactNode;
}): Promise<void> => {
  const { router, runsRoute } = buildRouter({
    initialEntry: input.initialEntry,
    component: () => input.render(runsRoute.useSearch()),
  });

  render(<RouterProvider router={router} />);
  await screen.findByTestId(READY);
};

/** search を見ない部品（`<Link>` だけのために router が要るもの）。 */
export const renderWithRouter = async (node: ReactNode): Promise<void> => {
  const { router } = buildRouter({
    initialEntry: "/runs",
    component: () => node,
  });

  render(<RouterProvider router={router} />);
  await screen.findByTestId(READY);
};
