"use client";

import { Download, FileSpreadsheet, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Export page (Spec 6 C16) — on-demand continuous contacts export, the
 * same contract as the daily scheduled export (spec 5). The route streams
 * the file directly, so a plain anchor download is the whole interaction;
 * RLS scopes it to the caller's own client.
 */
export default function ExportPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Export contacts</h1>
        <p className="text-sm text-muted-foreground">
          Download the current state of every contact: cleaning result,
          lead score, pipeline stage, consent, opt-out state, and last
          activity. Same columns as the daily emailed export.
        </p>
      </div>

      <Card className="gap-3 p-4">
        <div className="flex items-center gap-2 text-sm">
          <FileSpreadsheet className="size-4 text-emerald-600 dark:text-emerald-400" />
          <span className="font-medium">Excel (.xlsx)</span>
          <span className="text-muted-foreground">— best for spreadsheets</span>
          <Button
            className="ml-auto"
            size="sm"
            nativeButton={false}
            render={<a href="/api/contacts/export?format=xlsx" />}
          >
            <Download /> Download
          </Button>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <FileText className="size-4 text-sky-600 dark:text-sky-400" />
          <span className="font-medium">CSV</span>
          <span className="text-muted-foreground">— for import elsewhere</span>
          <Button
            className="ml-auto"
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<a href="/api/contacts/export?format=csv" />}
          >
            <Download /> Download
          </Button>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        Agents and above can export. Files are generated on demand and
        never stored publicly.
      </p>
    </div>
  );
}
