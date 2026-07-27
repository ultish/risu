/**
 * ExportBar — download transactions CSV and full SQLite backup.
 *
 * Wire into App.tsx:
 *   import ExportBar from "./ExportBar";
 *   // near filter bar or holdings header:
 *   <ExportBar filters={{ portfolioId, broker, source, ticker }} />
 */
import { type Filters, exportBackupUrl, exportTransactionsCsvUrl } from "./api";

type Props = {
  filters?: Filters;
  className?: string;
};

export default function ExportBar({ filters = {}, className }: Props) {
  const csvHref = exportTransactionsCsvUrl(filters);
  const backupHref = exportBackupUrl();
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const backupName = `risu-${day}.db`;

  return (
    <div
      className={
        className ??
        "flex flex-wrap items-center gap-2 text-sm"
      }
    >
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
    </div>
  );
}
