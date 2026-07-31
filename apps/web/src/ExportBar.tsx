/**
 * ExportBar — download transactions CSV / full SQLite backup, and restore
 * the database from a previously downloaded backup file.
 *
 * Wire into App.tsx:
 *   import ExportBar from "./ExportBar";
 *   // near filter bar or holdings header:
 *   <ExportBar filters={{ portfolioId, broker, source, ticker }} />
 */
import { useRef, useState } from "react";
import { type Filters, exportBackupUrl, exportTransactionsCsvUrl, restoreBackup } from "./api";

type Props = {
  filters?: Filters;
  className?: string;
};

export default function ExportBar({ filters = {}, className }: Props) {
  const csvHref = exportTransactionsCsvUrl(filters);
  const backupHref = exportBackupUrl();
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const backupName = `risu-${day}.db`;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;

    const ok = confirm(
      `Restore the database from "${file.name}"?\n\n` +
        "This replaces ALL current data with what's in that file. " +
        "A safety copy of your current database is kept on disk first, " +
        "but the app will immediately switch to the restored file.",
    );
    if (!ok) return;

    setRestoring(true);
    setRestoreMsg(null);
    try {
      await restoreBackup(file);
      setRestoreMsg({ kind: "ok", text: "Restored — reloading…" });
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setRestoring(false);
      setRestoreMsg({
        kind: "error",
        text: err instanceof Error ? err.message : "Restore failed",
      });
    }
  }

  return (
    <div className={className ?? "flex flex-col gap-2 text-sm"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
          Export
        </span>
        <a
          href={csvHref}
          download={`risu-transactions-${day}.csv`}
          className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-100 hover:bg-gray-700"
        >
          Transactions CSV
        </a>
        <a
          href={backupHref}
          download={backupName}
          className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-100 hover:bg-gray-700"
        >
          Backup DB
        </a>
        <span className="ml-2 text-xs font-medium uppercase tracking-wide text-gray-500">
          Restore
        </span>
        <button
          type="button"
          disabled={restoring}
          onClick={() => fileInputRef.current?.click()}
          className="rounded-lg border border-amber-700 bg-amber-950 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-900 disabled:opacity-50"
        >
          {restoring ? "Restoring…" : "Restore DB from file…"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".db"
          className="hidden"
          onChange={(e) => void onFileChosen(e)}
        />
      </div>
      {restoreMsg && (
        <p
          className={
            restoreMsg.kind === "ok" ? "text-xs text-emerald-400" : "text-xs text-red-400"
          }
        >
          {restoreMsg.text}
        </p>
      )}
    </div>
  );
}
