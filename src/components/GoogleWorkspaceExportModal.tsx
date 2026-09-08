import React, { useState, useEffect } from 'react';
import {
  FileText,
  Table,
  Check,
  ExternalLink,
  Copy,
  Sparkles,
  X,
  AlertCircle,
  Loader2,
  ShieldCheck,
  LogOut,
  Layers,
} from 'lucide-react';
import { type User } from 'firebase/auth';
import {
  googleSignIn,
  logoutGoogle,
  initAuth,
  exportScriptToGoogleDoc,
  exportScriptToGoogleSheet,
  type ExportResult,
} from '../utils/googleWorkspace';
import { VideoScript, VideoPlan, ResearchData } from '../types';

interface GoogleWorkspaceExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  videoScript: VideoScript;
  plan?: VideoPlan | null;
  research?: ResearchData | null;
  initialExportType?: 'doc' | 'sheet' | 'both';
}

export const GoogleWorkspaceExportModal: React.FC<GoogleWorkspaceExportModalProps> = ({
  isOpen,
  onClose,
  videoScript,
  plan,
  research,
  initialExportType = 'both',
}) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState<'doc' | 'sheet' | 'both'>(initialExportType);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStep, setExportStep] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportResults, setExportResults] = useState<ExportResult[]>([]);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [isSavingMd, setIsSavingMd] = useState(false);
  const [mdResult, setMdResult] = useState<{ relativePath: string; bytes: number } | null>(null);
  const [mdError, setMdError] = useState<string | null>(null);

  const handleSaveMarkdown = async () => {
    setIsSavingMd(true);
    setMdError(null);
    setMdResult(null);
    try {
      const res = await fetch('/api/export/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: videoScript, research, plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setMdResult({ relativePath: data.relativePath, bytes: data.bytes });
    } catch (err: any) {
      setMdError(err?.message || 'Failed to write markdown file');
    } finally {
      setIsSavingMd(false);
    }
  };

  useEffect(() => {
    if (initialExportType) {
      setSelectedFormat(initialExportType);
    }
  }, [initialExportType]);

  useEffect(() => {
    const unsubscribe = initAuth(
      (user) => {
        setCurrentUser(user);
        setErrorMessage(null);
      },
      () => {
        setCurrentUser(null);
      }
    );
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  if (!isOpen) return null;

  const handleSignIn = async () => {
    setIsSigningIn(true);
    setErrorMessage(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setCurrentUser(result.user);
      }
    } catch (err: any) {
      console.error('Sign in failed:', err);
      setErrorMessage(
        err.message ||
          'Google authentication was cancelled or blocked. Please enable popups and try again.'
      );
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await logoutGoogle();
      setCurrentUser(null);
      setExportResults([]);
    } catch (err: any) {
      console.error('Sign out error:', err);
    }
  };

  const handleConfirmExport = async () => {
    if (!currentUser) {
      setErrorMessage('Please sign in with Google first before exporting.');
      return;
    }

    setIsExporting(true);
    setErrorMessage(null);
    setExportResults([]);

    const results: ExportResult[] = [];

    try {
      if (selectedFormat === 'doc' || selectedFormat === 'both') {
        setExportStep('Generating formatted Google Doc in your Google Drive...');
        const docRes = await exportScriptToGoogleDoc(videoScript, plan, research);
        results.push(docRes);
      }

      if (selectedFormat === 'sheet' || selectedFormat === 'both') {
        setExportStep('Generating production Google Sheet with multi-tab schema...');
        const sheetRes = await exportScriptToGoogleSheet(videoScript, plan, research);
        results.push(sheetRes);
      }

      setExportResults(results);
      setExportStep('');
    } catch (err: any) {
      console.error('Export error:', err);
      setErrorMessage(err.message || 'Failed to export file to Google Workspace.');
    } finally {
      setIsExporting(false);
      setExportStep('');
    }
  };

  const handleCopyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedLink(url);
    setTimeout(() => setCopiedLink(null), 2500);
  };

  const totalWords = videoScript.scenes.reduce(
    (acc, s) => acc + (s.narration?.split(/\s+/).filter(Boolean).length || 0),
    0
  );
  const totalDuration = videoScript.scenes.reduce((acc, s) => acc + (s.durationEst || 10), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 p-6 sm:p-8 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
        {/* Close Button */}
        <button
          id="close-google-export-modal"
          onClick={onClose}
          className="absolute top-5 right-5 text-zinc-400 hover:text-zinc-100 p-1.5 rounded-lg hover:bg-zinc-900 transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-emerald-500 shadow-lg shadow-blue-500/20 text-white shrink-0">
            <Sparkles className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-white tracking-tight">
                Export Script to Google Workspace
              </h2>
              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-semibold text-blue-400 border border-blue-500/20">
                Docs & Sheets
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-1">
              Export your detailed scene-by-scene script, technical infographics, spoken voiceover, and timing cues directly to your Google Drive.
            </p>
          </div>
        </div>

        {/* Script Summary Card */}
        <div className="rounded-xl bg-zinc-900/80 border border-zinc-800/80 p-4 space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-orange-400 font-bold flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5" /> Selected Script Dossier
          </div>
          <div className="text-sm font-bold text-white line-clamp-1">{videoScript.title}</div>
          <div className="flex items-center gap-4 text-xs text-zinc-400 flex-wrap">
            <span>{videoScript.scenes.length} Scenes</span>
            <span>•</span>
            <span>~{totalDuration}s Runtime</span>
            <span>•</span>
            <span>{totalWords} Words</span>
            <span>•</span>
            <span className="text-emerald-400 font-semibold">{videoScript.targetPlatform}</span>
          </div>
        </div>

        {/* Markdown export — writes to exports/ on the local server, no sign-in */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
              <FileText className="h-4 w-4 text-amber-400" /> Markdown Brief
              <span className="ml-1 text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                No sign-in
              </span>
            </span>
          </div>
          <p className="text-xs text-zinc-400">
            Writes the full production brief — character bible, layered image prompts, motion direction and
            source citations — to <code className="text-amber-400">exports/</code> in the project folder.
          </p>
          <button
            id="export-markdown-button"
            type="button"
            onClick={handleSaveMarkdown}
            disabled={isSavingMd}
            className="w-full flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 text-white font-semibold px-4 py-2.5 rounded-xl transition-all shadow-md active:scale-[0.99] disabled:opacity-60 cursor-pointer"
          >
            {isSavingMd ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-xs">Writing brief...</span>
              </>
            ) : (
              <>
                <FileText className="h-4 w-4" />
                <span className="text-xs">Save Markdown to exports/</span>
              </>
            )}
          </button>
          {mdResult && (
            <div className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
              Saved <code className="font-semibold">{mdResult.relativePath}</code> ({(mdResult.bytes / 1024).toFixed(1)} KB)
            </div>
          )}
          {mdError && (
            <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {mdError}
            </div>
          )}
        </div>

        {/* Google Authentication Section */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-blue-400" /> Google Account Authorization
            </span>
            {currentUser && (
              <button
                onClick={handleSignOut}
                className="text-[11px] text-zinc-400 hover:text-rose-400 flex items-center gap-1 transition-colors"
                title="Sign out of Google"
              >
                <LogOut className="h-3 w-3" /> Disconnect
              </button>
            )}
          </div>

          {currentUser ? (
            <div className="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-emerald-500/30">
              <div className="flex items-center gap-3">
                {currentUser.photoURL ? (
                  <img
                    src={currentUser.photoURL}
                    alt={currentUser.displayName || 'Google User'}
                    className="h-8 w-8 rounded-full border border-zinc-700"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-xs">
                    {(currentUser.displayName || currentUser.email || 'G')[0].toUpperCase()}
                  </div>
                )}
                <div>
                  <div className="text-xs font-semibold text-zinc-200">
                    {currentUser.displayName || 'Connected Google User'}
                  </div>
                  <div className="text-[11px] text-zinc-400">{currentUser.email}</div>
                </div>
              </div>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
                <Check className="h-3 w-3" /> Ready
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-zinc-400">
                Sign in with your Google account to grant permission for this app to create Google Docs and Google Sheets in your Google Drive.
              </p>
              <button
                id="google-signin-button"
                type="button"
                onClick={handleSignIn}
                disabled={isSigningIn}
                className="w-full flex items-center justify-center gap-3 bg-white hover:bg-zinc-100 text-zinc-800 font-semibold px-4 py-2.5 rounded-xl transition-all shadow-md active:scale-[0.99] disabled:opacity-60 cursor-pointer"
              >
                {isSigningIn ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-zinc-700" />
                    <span className="text-xs">Connecting to Google...</span>
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" viewBox="0 0 48 48">
                      <path
                        fill="#EA4335"
                        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                      />
                      <path
                        fill="#4285F4"
                        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                      />
                      <path
                        fill="#34A853"
                        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                      />
                    </svg>
                    <span className="text-xs">Sign in with Google</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Format Selection Cards */}
        <div className="space-y-2.5">
          <label className="text-xs font-bold uppercase tracking-wider text-zinc-400 block">
            Choose Destination Format
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Google Doc Card */}
            <button
              type="button"
              id="export-format-doc"
              onClick={() => setSelectedFormat('doc')}
              className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
                selectedFormat === 'doc'
                  ? 'border-blue-500 bg-blue-500/10 shadow-lg shadow-blue-500/10'
                  : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <FileText className={`h-5 w-5 ${selectedFormat === 'doc' ? 'text-blue-400' : 'text-zinc-400'}`} />
                {selectedFormat === 'doc' && <Check className="h-4 w-4 text-blue-400" />}
              </div>
              <div className="text-xs font-bold text-white">Google Doc (.gdoc)</div>
              <p className="text-[11px] text-zinc-400 mt-1">
                Formatted narrative script, visual cues, continuous voiceover teleprompter & infographic notes.
              </p>
            </button>

            {/* Google Sheet Card */}
            <button
              type="button"
              id="export-format-sheet"
              onClick={() => setSelectedFormat('sheet')}
              className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
                selectedFormat === 'sheet'
                  ? 'border-emerald-500 bg-emerald-500/10 shadow-lg shadow-emerald-500/10'
                  : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <Table className={`h-5 w-5 ${selectedFormat === 'sheet' ? 'text-emerald-400' : 'text-zinc-400'}`} />
                {selectedFormat === 'sheet' && <Check className="h-4 w-4 text-emerald-400" />}
              </div>
              <div className="text-xs font-bold text-white">Google Sheet (.gsheet)</div>
              <p className="text-[11px] text-zinc-400 mt-1">
                Multi-tab spreadsheet with Scene Breakdown (timings, narration, SFX) and Production Dossier telemetry.
              </p>
            </button>

            {/* Both Card */}
            <button
              type="button"
              id="export-format-both"
              onClick={() => setSelectedFormat('both')}
              className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
                selectedFormat === 'both'
                  ? 'border-orange-500 bg-orange-500/10 shadow-lg shadow-orange-500/10'
                  : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <Sparkles className={`h-5 w-5 ${selectedFormat === 'both' ? 'text-orange-400' : 'text-zinc-400'}`} />
                {selectedFormat === 'both' && <Check className="h-4 w-4 text-orange-400" />}
              </div>
              <div className="text-xs font-bold text-white">Both (Doc + Sheet)</div>
              <p className="text-[11px] text-zinc-400 mt-1">
                Creates both Google Doc and Google Sheet simultaneously with direct 1-click access.
              </p>
            </button>
          </div>
        </div>

        {/* Error message */}
        {errorMessage && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-3.5 flex items-start gap-2.5 text-rose-300 text-xs">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
            <div className="space-y-1">
              <span className="font-semibold">Export Notice</span>
              <p>{errorMessage}</p>
            </div>
          </div>
        )}

        {/* Success Results Showcase */}
        {exportResults.length > 0 && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-4 space-y-3 animate-in fade-in">
            <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold uppercase tracking-wider">
              <Check className="h-4 w-4" /> Files Created in Google Drive!
            </div>
            <div className="space-y-2.5">
              {exportResults.map((res) => (
                <div
                  key={res.fileId}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg bg-zinc-900/90 border border-zinc-800"
                >
                  <div className="flex items-center gap-2.5">
                    {res.type === 'doc' ? (
                      <FileText className="h-5 w-5 text-blue-400 shrink-0" />
                    ) : (
                      <Table className="h-5 w-5 text-emerald-400 shrink-0" />
                    )}
                    <div>
                      <div className="text-xs font-bold text-white line-clamp-1">{res.title}</div>
                      <div className="text-[10px] text-zinc-400">
                        {res.type === 'doc' ? 'Google Document' : 'Google Spreadsheet'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleCopyLink(res.url)}
                      className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs flex items-center gap-1 transition-colors"
                    >
                      {copiedLink === res.url ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span>{copiedLink === res.url ? 'Copied' : 'Copy Link'}</span>
                    </button>
                    <a
                      href={res.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`px-3 py-1 rounded text-xs font-bold flex items-center gap-1.5 transition-all text-white ${
                        res.type === 'doc'
                          ? 'bg-blue-600 hover:bg-blue-500 shadow-sm shadow-blue-500/30'
                          : 'bg-emerald-600 hover:bg-emerald-500 shadow-sm shadow-emerald-500/30'
                      }`}
                    >
                      <span>Open in {res.type === 'doc' ? 'Docs' : 'Sheets'}</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Confirmation & Action Buttons */}
        <div className="pt-4 border-t border-zinc-800 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="text-[11px] text-zinc-400 text-center sm:text-left">
            Files are saved to your personal Google Drive and can be shared or edited in real time.
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={onClose}
              className="w-full sm:w-auto px-4 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 border border-zinc-800 transition-colors"
            >
              {exportResults.length > 0 ? 'Done' : 'Cancel'}
            </button>
            <button
              id="confirm-google-export-button"
              type="button"
              disabled={isExporting || !currentUser}
              onClick={handleConfirmExport}
              className="w-full sm:w-auto flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-emerald-600 hover:from-blue-500 hover:to-emerald-500 px-5 py-2 text-xs font-bold text-white shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50 cursor-pointer"
            >
              {isExporting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{exportStep || 'Exporting...'}</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>
                    {exportResults.length > 0
                      ? 'Export Again'
                      : `Confirm & Create in ${
                          selectedFormat === 'doc'
                            ? 'Google Docs'
                            : selectedFormat === 'sheet'
                            ? 'Google Sheets'
                            : 'Docs & Sheets'
                        }`}
                  </span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
