'use client';

import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Upload, FileText, Loader2, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';

function truncateFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const keep = max - ext.length - 1;
  return `${base.slice(0, Math.max(keep, 12))}…${ext}`;
}

interface ImportCounts {
  raw: number;
  clean: number;
  invalid: number;
  review: number;
  duplicate: number;
}

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function ImportModal({ open, onOpenChange, onImported }: ImportModalProps) {
  const t = useTranslations('Contacts.importModal');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [counts, setCounts] = useState<ImportCounts | null>(null);

  function reset() {
    setFile(null);
    setCounts(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setCounts(null);
  }

  async function handleImport() {
    if (!file) return;
    setImporting(true);

    try {
      const form = new FormData();
      form.append('file', file);

      const res = await fetch('/api/contacts/import', { method: 'POST', body: form });
      const body = (await res.json().catch(() => null)) as
        | { import_id?: string; counts?: ImportCounts; error?: string }
        | null;

      if (!res.ok || !body?.counts) {
        throw new Error(body?.error || t('toastError'));
      }

      setCounts(body.counts);
      if (body.counts.clean > 0) {
        toast.success(t('toastImported', { count: body.counts.clean }));
      }
      onImported();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-2xl">
        <div className="shrink-0 space-y-4 border-b border-border/80 px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-lg text-popover-foreground">{t('title')}</DialogTitle>
            <DialogDescription
              className="leading-relaxed text-muted-foreground"
              dangerouslySetInnerHTML={{
                __html: t.markup('desc', {
                  fileCode: (chunks) =>
                    `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  phoneCode: (chunks) =>
                    `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  nameCode: (chunks) =>
                    `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  emailCode: (chunks) =>
                    `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  headersCode: (chunks) =>
                    `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                }),
              }}
            />
          </DialogHeader>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            className={cn(
              'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
              file
                ? 'border-primary/35 bg-primary/[0.04]'
                : 'hover:border-primary/40 border-border/80 bg-background/40 hover:bg-background/70'
            )}
          >
            {file ? (
              <>
                <div className="bg-primary/15 ring-primary/25 flex size-10 items-center justify-center rounded-lg ring-1">
                  <FileText className="text-primary size-5" />
                </div>
                <p
                  className="max-w-full truncate px-2 text-sm font-medium text-popover-foreground"
                  title={file.name}
                >
                  {truncateFilename(file.name)}
                </p>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {t('fileReady')}
                </span>
              </>
            ) : (
              <>
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors group-hover:bg-muted">
                  <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">{t('uploadDropzone')}</p>
                <p className="text-[11px] text-muted-foreground">{t('uploadHint')}</p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {counts && (
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <p className="text-sm font-medium text-popover-foreground">{t('importComplete')}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <div className="text-primary flex items-center gap-1.5 text-sm">
                  <CheckCircle className="size-4 shrink-0" />
                  {t('resultClean', { count: counts.clean })}
                </div>
                {counts.review > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {t('resultReview', { count: counts.review })}
                  </div>
                )}
                {counts.duplicate > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {t('resultDuplicate', { count: counts.duplicate })}
                  </div>
                )}
                {counts.invalid > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-red-400">
                    <XCircle className="size-4 shrink-0" />
                    {t('resultInvalid', { count: counts.invalid })}
                  </div>
                )}
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                {t('resultRaw', { count: counts.raw })}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border/80 bg-background/50 px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {counts ? t('close') : t('cancel')}
          </Button>
          {!counts && (
            <Button
              type="button"
              disabled={!file || importing}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              {t('importBtn')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
