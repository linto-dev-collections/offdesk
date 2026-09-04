import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/*
  jsdom に無いブラウザ API を埋める。

  **どちらも「無いと落ちる」ものだけ。** 振る舞いを真似はしない ——
  真似た瞬間に「テストだけ通る」が生まれるので、**呼ばれても落ちない**だけの
  形にしてある（レイアウトに依存する検査はここでは書かない）。
*/

if (!("matchMedia" in window)) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  });
}

/*
  **jsdom は `scrollTo` を実装していない。** TanStack Router は遷移のたびに
  スクロール位置を戻そうとするので、埋めないと出力が
  `Not implemented: Window's scrollTo()` で埋まる（テストは通るが読めなくなる）。
*/
Object.defineProperty(window, "scrollTo", { writable: true, value: vi.fn() });

if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    value: class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  });
}

/*
  **各テストの後に DOM を空にする。** `@testing-library/react` は
  `globals: true` のときだけ自動で片付けるので、明示する
  （`vitest.client.config.ts` は globals を立てていない）。
*/
afterEach(() => {
  cleanup();
});
