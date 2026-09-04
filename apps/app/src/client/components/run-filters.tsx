import {
  RUN_SINCE_DAYS_DEFAULT,
  RUN_STATUSES,
  type RunListQuery,
} from "@offdesk/contract";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/ui/select";
import { runStatusLabel } from "./run-status-badge.tsx";

/** 「すべて」を表す値。**空文字は `RunListQuery` が `undefined` に倒す**（`.min(1)`）。 */
const ALL = "";

type Option<T extends string> = {
  readonly value: T;
  readonly label: string;
};

const FilterSelect = <T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly Option<T>[];
  readonly onChange: (value: T) => void;
}) => (
  /*
    **`<label>` で包まない。** 中身は Base UI の trigger（`<button>`）で、
    `<label>` が結び付けられるフォーム部品ではないので
    `a11y/noLabelWithoutControl` に当たる —— 見える文字は `<span>` で出し、
    支援技術には `aria-label` で同じ文字を渡す。
  */
  <div className="flex items-center gap-2 text-muted-foreground text-xs">
    <span>{label}</span>
    <Select
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
);

const STATUS_OPTIONS: readonly Option<string>[] = [
  { value: ALL, label: "すべて" },
  ...RUN_STATUSES.map((status) => ({
    value: status as string,
    label: runStatusLabel(status),
  })),
];

const SINCE_OPTIONS: readonly Option<string>[] = [
  { value: "7", label: "7 日" },
  { value: "30", label: "30 日" },
  { value: "90", label: "90 日" },
  { value: "365", label: "1 年" },
];

/**
 * 並び替え（plans/security.md 脅威 11）。
 *
 * **`sort` と `order` を 1 つの操作にまとめた。** 列見出しを押す形にすると、
 * `updatedAt` は表に列が無いので押す場所が無くなる ——
 * 4 通りを名前で選ばせる方が、URL に載る値と画面の見え方が 1 対 1 になる。
 *
 * 値は `<sort>:<order>` で、**どちらも契約の `z.enum` を通る**ので
 * allowlist の外は SQL に届かない。
 */
const SORT_OPTIONS: readonly Option<string>[] = [
  { value: "createdAt:desc", label: "開始が新しい順" },
  { value: "createdAt:asc", label: "開始が古い順" },
  { value: "updatedAt:desc", label: "更新が新しい順" },
  { value: "updatedAt:asc", label: "更新が古い順" },
];

export type ProjectOption = {
  readonly id: string;
  readonly name: string;
};

/**
 * 絞り込み（要件 `F-F2`）。**状態は 1 つも持たない。**
 *
 * 選ぶと `onChange` が呼ばれ、呼ぶ側が URL を書き換える ——
 * コンポーネント側に `useState` を置くと URL と画面の 2 か所に状態ができて、
 * 「URL を直に開くと絞り込みが消える」に戻る。
 */
export const RunFilters = ({
  query,
  projects,
  onChange,
  onReset,
}: {
  readonly query: RunListQuery;
  readonly projects: readonly ProjectOption[];
  readonly onChange: (patch: Partial<RunListQuery>) => void;
  readonly onReset: () => void;
}) => {
  const projectOptions: readonly Option<string>[] = [
    { value: ALL, label: "すべて" },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ];

  const filtered =
    query.projectId !== undefined ||
    query.status !== undefined ||
    query.sinceDays !== RUN_SINCE_DAYS_DEFAULT ||
    query.sort !== "createdAt" ||
    query.order !== "desc";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <FilterSelect
        label="プロジェクト"
        value={query.projectId ?? ALL}
        options={projectOptions}
        onChange={(value) =>
          onChange({ projectId: value === ALL ? undefined : value })
        }
      />
      <FilterSelect
        label="状態"
        value={query.status ?? ALL}
        options={STATUS_OPTIONS}
        onChange={(value) =>
          /*
            `RunStatus` へ絞り込まずに渡している。**受け取る側が Zod で
            検査する**ので、ここで型を主張しても二重になるだけ ——
            `ALL` の分岐だけを持つ。
          */
          onChange({
            status:
              value === ALL
                ? undefined
                : (value as NonNullable<RunListQuery["status"]>),
          })
        }
      />
      <FilterSelect
        label="期間"
        value={String(query.sinceDays)}
        options={SINCE_OPTIONS}
        onChange={(value) => onChange({ sinceDays: Number(value) })}
      />
      <FilterSelect
        label="並び"
        value={`${query.sort}:${query.order}`}
        options={SORT_OPTIONS}
        onChange={(value) => {
          const [sort, order] = value.split(":");
          onChange({
            sort: sort as RunListQuery["sort"],
            order: order as RunListQuery["order"],
          });
        }}
      />
      {filtered ? (
        <Button variant="ghost" size="sm" onClick={onReset}>
          絞り込みを外す
        </Button>
      ) : null}
    </div>
  );
};
