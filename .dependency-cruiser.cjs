/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  extends: "dependency-cruiser/configs/recommended-strict",

  // ---------------------------------------------------------------------------
  // 要件 §10-3-1「依存性のルールを機械で強制する」の 3 段目。
  //
  //   1. バレル      各パッケージの公開面を exports に載せたものだけに絞る
  //   2. tsconfig    tsconfig.client.json が src/worker を include しない ＋ Vite の環境分離（client から cloudflare:workers に到達すると落ちる）
  //   3. ここ        CI で検査する
  //
  // 1 と 2 は「解決できない」「ビルドが落ちる」という形で守るが、型を経由しない副作用 import はすり抜ける。最後の砦としてこのファイルを置く。
  //
  // 各ルールに comment で why を書く。落ちた人に「なぜ禁止か」が届かないと、規則は迂回される（要件 §10-3-1）。
  // ---------------------------------------------------------------------------
  forbidden: [
    {
      // recommended-strict の no-orphans を、設定ファイルとテストと生成物には当てない。
      // vite.config.ts / alchemy.run.ts はツールが直接読むエントリで、どこからも import されないのが正しい。
      name: "no-orphans",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)[.][^/]+[.](?:js|cjs|mjs|ts|cts|mts|json)$",
          "[.]d[.]ts$",
          // 2 本に分けているのは、`(?:[.][a-z-]+)?` のように量指定子を任意グループの中へ入れると dependency-cruiser の safe-regex 検査が「unsafe regular expression」でルールごと弾くため（実測）。
          "(^|/)tsconfig[.]json$",
          "(^|/)tsconfig[.][a-z]+[.]json$",
          "(^|/)(?:vite|vitest|drizzle|knip)[.]config[.](?:js|cjs|mjs|ts|cts|mts|json)$",
          // `vitest.release.config.ts` のような環境別の設定。プールごとに 1 本ある。
          "(^|/)vitest[.][a-z]+[.]config[.]ts$",
          // テストファイルは vitest が直接読むエントリ。
          "[.]test[.]tsx?$",
          // setupFiles も vitest が直接読むエントリ。
          "(^|/)vitest[.]setup[.]ts$",
          // Alchemy CLI が直接読むエントリ。
          "(^|/)alchemy[.]run[.]ts$",
          // TanStack Router の生成物。
          "(^|/)routeTree[.]gen[.]ts$",
          // `packages/ui/src/hooks` は `components/ui` からしか使われず、あちらは
          // 上の exclude でグラフから外れている。**入ってくる辺が消えるので必ず孤児になる。**
          // 手で書いた hook を足したときも見逃すが、knip と biome は見ている。
          "^packages/ui/src/hooks/",
        ],
      },
      to: {},
    },
    {
      name: "client-no-worker",
      comment:
        "apps/app/src/client から src/worker への import を禁止する。" +
        "Worker 側のコードには秘密（fire トークン・D1 バインディング・Discord の鍵）へ" +
        "到達する経路があり、1 行でも混ざるとブラウザへ配られるバンドルに載る" +
        "（要件 I-1 が破れる／plans/security.md 脅威 4）。**型検査では止まらない** — " +
        "型は消えるだけで import は残る。両側で使う型は packages/contract に置く。",
      severity: "error",
      from: { path: "^apps/app/src/client/" },
      to: { path: "^apps/app/src/worker/" },
    },
    {
      name: "client-no-server-packages",
      comment:
        "apps/app/src/client からサーバー専用パッケージへの import を禁止する。" +
        "@offdesk/db は D1 バインディングを、@offdesk/usecase と @offdesk/domain は" +
        "port の宣言と業務規則を、@offdesk/infra は Cloudflare の資格情報を握る。" +
        "クライアントが必要とするのは契約だけなので、共有したいスキーマは " +
        "@offdesk/contract へ移す（要件 I-8）。" +
        "**@offdesk/auth はここに入れず client-no-auth-server でファイル単位に絞る** — " +
        "あのパッケージだけは client 用の入口（./client）を持つため。",
      severity: "error",
      from: { path: "^apps/app/src/client/" },
      to: {
        path: [
          "^packages/(db|usecase|domain|infra)/",
          "^@offdesk/(db|usecase|domain|infra)($|/)",
        ],
      },
    },
    {
      name: "client-no-auth-server",
      comment:
        "apps/app/src/client から @offdesk/auth のサーバー面（`.` ＝ src/index.ts）への " +
        "import を禁止する。あちらは BETTER_AUTH_SECRET と GOOGLE_CLIENT_SECRET、" +
        "そして D1 バインディングに到達する。クライアントが使うのは " +
        "@offdesk/auth/client（createAuthClient だけ）で、そちらは better-auth/client " +
        "以外を何も掴まない。**パッケージ名で丸ごと禁止できないのはこの 1 つだけ**なので、" +
        "ファイル単位で書いてある。",
      severity: "error",
      from: { path: "^apps/app/src/client/" },
      to: { path: "^packages/auth/src/index[.]ts$" },
    },
    {
      name: "ui-no-app-packages",
      comment:
        "packages/ui から他のワークスペースパッケージへの import を禁止する。" +
        "UI は表示だけを担う葉のパッケージに保ち、DB・ドメイン・契約の都合を持ち込まない。" +
        "この向きが崩れると、shadcn の生成物を入れ替えるたびにアプリの型が動く。",
      severity: "error",
      from: { path: "^packages/ui/" },
      to: {
        path: [
          "^packages/(db|auth|usecase|domain|contract|infra)/",
          "^@offdesk/[a-z]+($|/)",
        ],
      },
    },
    {
      name: "cli-is-http-only",
      comment:
        "packages/cli から db / auth / usecase / infra への import を禁止する。" +
        "運用スクリプトは**本番の Worker に HTTP で話すだけ**で、D1 にも鍵にも触らない。" +
        "ここで @offdesk/db を掴むと、暗号化を手元で行うことになり " +
        "FIRE_TOKEN_KEY を開発機と CI にも配ることになる（要件 F-H2 は「鍵は Worker " +
        "secret に置き、復号は Worker の中だけ」と定めている。2026-09-04 の決定）。" +
        "投入の形は packages/contract の Zod が持ち、Worker 側の投入口が同じものを見る。",
      severity: "error",
      from: { path: "^packages/cli/" },
      to: {
        path: [
          "^packages/(db|auth|usecase|infra)/",
          "^@offdesk/(db|auth|usecase|infra)($|/)",
          "^(drizzle-orm|better-auth|hono|alchemy)($|/)",
        ],
      },
    },
    {
      name: "contract-is-terminal",
      comment:
        "packages/contract は依存の終着点（要件 I-8）。矢印は必ず contract に向かい、" +
        "contract からは出ない。ここが下流を掴むと、クライアントとサーバーが共有する" +
        "はずの契約にサーバー実装が引きずられて循環する。実行時依存は zod だけ。",
      severity: "error",
      from: { path: "^packages/contract/src" },
      to: {
        path: [
          "^packages/(db|auth|usecase|domain|infra|ui)/",
          "^@offdesk/(db|auth|usecase|domain|infra)($|/)",
          "^@workspace/",
          "^(hono|drizzle-orm|better-auth|@orpc/server)($|/)",
        ],
      },
    },
    {
      name: "domain-is-pure",
      comment:
        "packages/domain は副作用と外部ライブラリを持たない（要件 §10-2）。" +
        "外部サービスは port として宣言し、実装はアダプタに置く。違反したときは、" +
        "port の引数を Uint8Array や ReadableStream のような標準型へ置き換える。" +
        "ここが純粋である限り、業務規則は D1 も Discord も無しでテストできる。",
      severity: "error",
      from: { path: "^packages/domain/src" },
      to: {
        path: [
          "^packages/(db|auth|usecase|contract|ui|infra)/",
          "^@offdesk/[a-z]+($|/)",
          "^@workspace/",
          "^(hono|drizzle-orm|better-auth|@orpc/server|marked|github-slugger)($|/)",
        ],
      },
    },
    {
      name: "usecase-no-outer",
      comment:
        "ユースケースは port だけを見る（要件 §10-3 ルール 3）。アダプタを直接掴むと" +
        "差し替えができず、テストに実物（D1・Anthropic・Discord）が要る。" +
        "違反したときは port を domain に宣言して実装をアダプタへ置く。",
      severity: "error",
      from: { path: "^packages/usecase/src" },
      to: {
        path: [
          "^packages/(db|auth|infra)/",
          "^@offdesk/(db|auth|infra)($|/)",
          "^(hono|drizzle-orm|better-auth)($|/)",
        ],
      },
    },
    {
      name: "no-deep-import",
      comment:
        "他のワークスペースパッケージへ相対パスで入り込む import を禁止する" +
        "（要件 §10-3-1 のバレル）。パッケージの公開面は package.json の exports " +
        "だけで、そこに載っていないファイルは外から見えない約束になっている。" +
        "相対パスで跨ぐとその約束が無効になり、内側の構造を変えるたびに外側が壊れる。" +
        "パッケージ名（@offdesk/* / @workspace/ui）で import する。",
      severity: "error",
      from: { path: "^(apps|packages)/([^/]+)/" },
      to: {
        path: "^(?:apps|packages)/",
        pathNot: "^$1/$2/",
        // 相対 import だけを見る。パッケージ名での import は exports を通るので、公開面に載っていなければそもそも解決できない（not-to-unresolvable が拾う）。
        dependencyTypes: ["local"],
      },
    },
    {
      name: "cloudflare-runtime-only-in-adapters",
      comment:
        "`cloudflare:*` の import はアダプタと Worker だけ。domain / usecase / " +
        "contract / client に来たらエラー（ランタイム固有の型がレイヤを越えている合図）。",
      severity: "error",
      from: {
        path: "^packages/(domain|usecase|contract)/src|^apps/app/src/client/",
      },
      to: { path: "^cloudflare:" },
    },
    {
      /*
        `cloudflare:*` は Workers ランタイムが供給する仮想モジュールで、バンドラを介さない解決器には見えない。
        recommended-strict の not-to-unresolvable をこの 1 点だけ緩める。

        `exclude` で除外しないのは、それをすると依存の辺そのものがグラフから消えて cloudflare-runtime-only-in-adapters が発火できなくなるため。
      */
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true, pathNot: "^cloudflare:" },
    },
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "node_modules",
        "\\.wrangler",
        "dist",
        "\\.alchemy",
        "\\.turbo",
        // `shadcn add` の生成物。**編集禁止なので、依存の向きを指摘しても直せない。**
        // 置き場を `components/ui` に分けてあるのは、この 1 行で丸ごと外せるようにするため
        // （`components/block` は手で書くので検査に残す）。biome と knip も同じ境界で外している。
        "^packages/ui/src/components/ui/",
      ],
    },
    // 必須。これが無いと `import type` が見えず、要件 I-12 が止めたいものがそのまま通り抜ける（型だけの import でも境界は越えている）。
    tsPreCompilationDeps: true,
    // パスエイリアス（@/*）は使わない。ルートから一括で cruise する構成では tsconfig の paths がワークスペースのルート基準で解決されず、ツール側だけが解決に失敗する状態になる（計画 README §2-3）。
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
