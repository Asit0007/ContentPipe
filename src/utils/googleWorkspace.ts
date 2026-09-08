import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  type User,
} from 'firebase/auth';
import { VideoScript, VideoPlan, ResearchData } from '../types';

export const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

// Firebase web config. These values are public by design — they ship inside the
// browser bundle — but they are kept out of the repo so the project's identifiers
// are not published to source control. Access is gated by Firebase Security Rules,
// the OAuth authorized-domain list, and API key restrictions in Google Cloud.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  console.error(
    'Firebase is not configured. Copy .env.example to .env and fill in the ' +
      'VITE_FIREBASE_* values; Google Workspace export will not work until you do.'
  );
}

// Initialize Firebase App singleton safely
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
SCOPES.forEach((scope) => {
  provider.addScope(scope);
});

// Prompt consent to ensure refresh & access tokens with requested scopes
provider.setCustomParameters({
  prompt: 'consent',
  access_type: 'offline',
});

let isSigningIn = false;
let cachedAccessToken: string | null = null;

/**
 * Initialize auth state listener. Call on app load.
 */
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        // Token must be acquired via interactive sign-in with popup
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

/**
 * Interactive Sign-In with Google via Firebase Auth popup
 */
export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Could not obtain Google OAuth access token from sign-in.');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Google Sign-in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

/**
 * Get current in-memory access token
 */
export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

/**
 * Sign out from Google Auth and clear in-memory token
 */
export const logoutGoogle = async (): Promise<void> => {
  await signOut(auth);
  cachedAccessToken = null;
};

export interface ExportResult {
  fileId: string;
  url: string;
  title: string;
  type: 'doc' | 'sheet';
}

/**
 * Format and export the detailed script to a new Google Doc
 */
export const exportScriptToGoogleDoc = async (
  videoScript: VideoScript,
  plan?: VideoPlan | null,
  research?: ResearchData | null
): Promise<ExportResult> => {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('No active Google authentication token. Please sign in with Google first.');
  }

  const docTitle = `[HN Script] ${videoScript.title || 'Detailed Infotainment Script'}`;

  // 1. Create document
  const createRes = await fetch('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: docTitle,
    }),
  });

  if (!createRes.ok) {
    const errData = await createRes.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `Google Docs API returned error: ${createRes.status}`);
  }

  const docData = await createRes.json();
  const documentId = docData.documentId;

  // 2. Build comprehensive text content
  const totalWords = videoScript.scenes.reduce(
    (acc, s) => acc + (s.narration?.split(/\s+/).filter(Boolean).length || 0),
    0
  );
  const totalDuration = videoScript.scenes.reduce((acc, s) => acc + (s.durationEst || 10), 0);
  const wpm = Math.round((totalWords / (Math.max(totalDuration, 1) / 60))) || 150;

  let bodyText = `HACKER NEWS INFOTAINMENT PRODUCTION SCRIPT\n`;
  bodyText += `Title: ${videoScript.title}\n`;
  bodyText += `Target Platform: ${videoScript.targetPlatform} | Aspect Ratio: ${videoScript.aspectRatio}\n`;
  bodyText += `Virality Score: ${videoScript.viralityScore || 95}/100 | Estimated Duration: ~${totalDuration}s\n`;
  bodyText += `Total Words: ${totalWords} (~${wpm} WPM) | Total Scenes: ${videoScript.scenes.length}\n`;
  bodyText += `Exported Date: ${new Date().toLocaleString()}\n\n`;

  bodyText += `========================================================\n`;
  bodyText += `EXECUTIVE PRODUCTION OVERVIEW\n`;
  bodyText += `========================================================\n`;
  if (videoScript.signatureIntro) {
    bodyText += `SIGNATURE INTRO HOOK:\n"${videoScript.signatureIntro}"\n\n`;
  }
  if (plan?.callToAction) {
    bodyText += `CALL TO ACTION:\n"${plan.callToAction}"\n\n`;
  }
  if (videoScript.signatureOutro) {
    bodyText += `SIGNATURE OUTRO:\n"${videoScript.signatureOutro}"\n\n`;
  }

  if (plan) {
    bodyText += `TARGET AUDIENCE & STRATEGY:\n${plan.targetAudience || 'Engineered for developer virality and retention.'}\n`;
    if (plan.hookStrategy) {
      bodyText += `Hook Strategy: ${plan.hookStrategy}\n\n`;
    }
  }

  bodyText += `========================================================\n`;
  bodyText += `DETAILED SCENE-BY-SCENE PRODUCTION BLUEPRINT\n`;
  bodyText += `========================================================\n\n`;

  videoScript.scenes.forEach((scene, index) => {
    bodyText += `--------------------------------------------------------\n`;
    bodyText += `SCENE ${scene.sceneNumber}: ${scene.title.toUpperCase()} [${scene.actPhase || 'Beat'}]\n`;
    bodyText += `--------------------------------------------------------\n`;
    bodyText += `• Duration: ~${scene.durationEst}s | Word Count: ${scene.wordCount || scene.narration.split(/\s+/).length} words\n`;
    if (scene.cinematography) {
      bodyText += `• Cinematography & Framing: ${scene.cinematography}\n`;
    }
    bodyText += `• On-Screen Kinetic Text: "${scene.onScreenText || ''}"\n`;
    if (scene.soundEffect) {
      bodyText += `• Sound Design (SFX): ${scene.soundEffect}\n`;
    }
    if (scene.retentionNote) {
      bodyText += `• Viewer Retention Psychology: ${scene.retentionNote}\n`;
    }

    bodyText += `\nVOICEOVER / NARRATION SCRIPT:\n`;
    bodyText += `"${scene.narration}"\n\n`;

    bodyText += `VISUAL DIRECTIVE & ART PROMPT:\n`;
    bodyText += `${scene.visualPrompt}\n\n`;

    if (scene.infographic) {
      bodyText += `TECHNICAL INFOGRAPHIC SPECIFICATION:\n`;
      bodyText += `• Type: ${scene.infographic.type.toUpperCase()}\n`;
      bodyText += `• Title: ${scene.infographic.title}\n`;
      if (scene.infographic.badge) {
        bodyText += `• Badge: [${scene.infographic.badge}]\n`;
      }
      if (scene.infographic.summary) {
        bodyText += `• Summary: ${scene.infographic.summary}\n`;
      }

      if (scene.infographic.steps && scene.infographic.steps.length > 0) {
        bodyText += `• Architecture / Flow Steps:\n`;
        scene.infographic.steps.forEach((step, sIdx) => {
          bodyText += `   [${sIdx + 1}] ${step.label} (${step.status}): ${step.detail}\n`;
        });
      }

      if (scene.infographic.metrics && scene.infographic.metrics.length > 0) {
        bodyText += `• Telemetry & Metrics:\n`;
        scene.infographic.metrics.forEach((m) => {
          bodyText += `   - ${m.label}: ${m.value} ${m.subtext ? `(${m.subtext})` : ''}\n`;
        });
      }

      if (scene.infographic.codeSnippet) {
        bodyText += `• Terminal / Code Payload (${scene.infographic.codeSnippet.language}):\n`;
        scene.infographic.codeSnippet.lines.forEach((line) => {
          bodyText += `   ${line.text}\n`;
        });
      }

      if (scene.infographic.commentQuote) {
        bodyText += `• Featured Hacker News Quote: "${scene.infographic.commentQuote.comment}" -- by ${scene.infographic.commentQuote.author} (${scene.infographic.commentQuote.karma} upvotes)\n`;
      }
      bodyText += `\n`;
    }
  });

  bodyText += `========================================================\n`;
  bodyText += `VOICEOVER TELEPROMPTER READ-THROUGH (CONTINUOUS)\n`;
  bodyText += `========================================================\n\n`;
  if (videoScript.signatureIntro) {
    bodyText += `${videoScript.signatureIntro}\n\n`;
  }
  videoScript.scenes.forEach((scene) => {
    bodyText += `[Scene ${scene.sceneNumber}] ${scene.narration}\n\n`;
  });
  if (videoScript.signatureOutro) {
    bodyText += `${videoScript.signatureOutro}\n\n`;
  }

  // 3. BatchUpdate to insert text into the newly created document
  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text: bodyText,
          },
        },
      ],
    }),
  });

  if (!updateRes.ok) {
    const updateErr = await updateRes.json().catch(() => ({}));
    console.warn('Batch update issue:', updateErr);
  }

  return {
    fileId: documentId,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
    title: docTitle,
    type: 'doc',
  };
};

/**
 * Format and export the detailed script to a new Google Sheet
 */
export const exportScriptToGoogleSheet = async (
  videoScript: VideoScript,
  plan?: VideoPlan | null,
  research?: ResearchData | null
): Promise<ExportResult> => {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('No active Google authentication token. Please sign in with Google first.');
  }

  const sheetTitle = `[HN Script] ${videoScript.title || 'Detailed Infotainment Script'}`;

  // 1. Create Spreadsheet with two structured worksheets
  const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        title: sheetTitle,
      },
      sheets: [
        {
          properties: {
            title: 'Scene Breakdown & Script',
            gridProperties: {
              frozenRowCount: 1,
            },
          },
        },
        {
          properties: {
            title: 'Production Dossier',
            gridProperties: {
              frozenRowCount: 1,
            },
          },
        },
      ],
    }),
  });

  if (!createRes.ok) {
    const errData = await createRes.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `Google Sheets API returned error: ${createRes.status}`);
  }

  const sheetData = await createRes.json();
  const spreadsheetId = sheetData.spreadsheetId;

  // 2. Prepare Tabular Data for Scene Breakdown
  const totalWords = videoScript.scenes.reduce(
    (acc, s) => acc + (s.narration?.split(/\s+/).filter(Boolean).length || 0),
    0
  );
  const totalDuration = videoScript.scenes.reduce((acc, s) => acc + (s.durationEst || 10), 0);
  const wpm = Math.round((totalWords / (Math.max(totalDuration, 1) / 60))) || 150;

  const sceneRows = videoScript.scenes.map((scene) => {
    let infographicSummary = 'None';
    if (scene.infographic) {
      const parts = [`Type: ${scene.infographic.type}`, scene.infographic.title];
      if (scene.infographic.summary) parts.push(scene.infographic.summary);
      if (scene.infographic.metrics?.length) {
        parts.push(scene.infographic.metrics.map((m) => `${m.label}: ${m.value}`).join(' | '));
      }
      infographicSummary = parts.join(' - ');
    }

    return [
      `Scene ${scene.sceneNumber}`,
      scene.title,
      scene.actPhase || 'Beat',
      scene.durationEst || 10,
      scene.wordCount || scene.narration.split(/\s+/).length,
      scene.narration,
      scene.visualPrompt,
      scene.onScreenText || '',
      scene.soundEffect || '',
      scene.retentionNote || '',
      scene.cinematography || '',
      scene.infographic?.type || 'standard',
      infographicSummary,
      scene.generatedAudioBase64 ? 'Generated (Ready)' : 'Pending',
      scene.generatedImageUrl ? 'Rendered (Ready)' : 'Pending',
    ];
  });

  const breakdownHeader = [
    'Scene #',
    'Scene Title',
    'Act / Beat',
    'Est. Duration (s)',
    'Word Count',
    'Narration Voiceover (Spoken Audio)',
    'Visual Directive & Prompt',
    'On-Screen Kinetic Text',
    'Sound Design (SFX)',
    'Retention Psychological Hook',
    'Cinematography & Framing',
    'Infographic Type',
    'Infographic Details & Architecture',
    'TTS Audio Status',
    'Visual Status',
  ];

  const metadataValues = [
    ['Dossier Parameter', 'Production Value', 'Notes'],
    ['Episode Script Title', videoScript.title, 'Hacker News viral adaptation'],
    ['Target Platform', videoScript.targetPlatform, 'Optimized layout & pacing'],
    ['Aspect Ratio', videoScript.aspectRatio, 'Format framing'],
    ['Virality Score', `${videoScript.viralityScore || 95} / 100`, 'High-retention structure'],
    ['Total Scene Count', String(videoScript.scenes.length), 'Full narrative arc'],
    ['Total Duration Est.', `~${totalDuration} seconds`, 'Calculated run time'],
    ['Total Word Count', `${totalWords} words`, `Target speed: ~${wpm} WPM`],
    ['Signature Intro Hook', videoScript.signatureIntro || '', 'Opening 3 seconds'],
    ['Call To Action (CTA)', plan?.callToAction || '', 'Mid-to-end engagement'],
    ['Signature Outro', videoScript.signatureOutro || '', 'Channel branding signoff'],
    ['Export Timestamp', new Date().toLocaleString(), 'Created via AI Studio'],
  ];

  // 3. Populate Sheet Values via batchUpdate
  const populateRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: [
          {
            range: `'Scene Breakdown & Script'!A1:O${sceneRows.length + 1}`,
            values: [breakdownHeader, ...sceneRows],
          },
          {
            range: `'Production Dossier'!A1:C${metadataValues.length}`,
            values: metadataValues,
          },
        ],
      }),
    }
  );

  if (!populateRes.ok) {
    const popErr = await populateRes.json().catch(() => ({}));
    console.warn('Sheets populate issue:', popErr);
  }

  return {
    fileId: spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    title: sheetTitle,
    type: 'sheet',
  };
};
