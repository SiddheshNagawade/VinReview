/// <reference types="vite/client" />
import React, { useState, useEffect, useRef } from 'react';
import ReactPlayer from 'react-player';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus, Share2, CheckCircle2, XCircle, MessageSquare, Play, Pause, ChevronLeft,
  Trash2, ExternalLink, Check, Mic, Pencil, Send, X, Volume2, Maximize,
  Minimize, Filter, Monitor, Eye, EyeOff, Calendar, Clock, Download,
  HelpCircle, Image, Layout, List, LogOut, Moon, MoreVertical, Music,
  RefreshCw, Search, Settings, Star, User, Video, Zap, Menu, ChevronUp,
  History, Square, Eraser, ZoomIn
} from 'lucide-react';
import { nanoid } from 'nanoid';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { getProjects, saveProjects, clearLocalStorage } from './db';

// --- Utilities ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function extractDriveId(url: string) {
  return url.match(/\/file\/d\/([^\/]+)/)?.[1] || url.match(/id=([^\&]+)/)?.[1];
}

function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- Types ---
type CommentType = 'text' | 'audio' | 'drawing' | 'combined';

interface DrawingPath {
  points: { x: number; y: number }[]; // normalized 0-1
  color: string;
  width: number;
}

interface DrawingData {
  paths: DrawingPath[];
}

interface Comment {
  id: string;
  timestamp: number;
  text?: string;
  audioUrl?: string;
  drawing?: DrawingData;
  type: CommentType;
  createdAt: number;
  resolved: boolean;
}

interface Project {
  id: string;
  name: string;
  videoUrl: string;
  fileId?: string;           // Google Drive fileId for health checks
  sourceType?: 'drive' | 'youtube' | 'direct'; // How the video was ingested
  thumbnailUrl?: string;     // Cached from Drive API on ingest
  videoDuration?: number;    // Cached from Drive API on ingest (seconds)
  sourceMissing?: boolean;   // Transient: set by health check on dashboard load
  comments: Comment[];
  isApproved: boolean;
  createdAt: number;
}
// --- Types ---


// --- Utilities ---
const getYouTubeEmbedId = (url: string): string | null => {
  if (!url) return null;
  // Match standard watch URLs, short URLs, embed URLs
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/)|youtu\.be\/)([\w-]{11})/
  );
  return match ? match[1] : null;
};

const transformVideoUrl = (url: string) => {
  if (!url) return '';

  // Google Drive
  if (url.includes('drive.google.com') || url.includes('docs.google.com')) {
    const fileId = extractDriveId(url);
    if (fileId) {
      // docs.google.com uc links are sometimes more reliable for streaming than drive.google.com
      return `https://docs.google.com/uc?export=download&id=${fileId}`;
    }
  }

  // YouTube: always convert to embed format with iframe API enabled and clean UI
  const ytId = getYouTubeEmbedId(url);
  if (ytId) {
    return `https://www.youtube.com/embed/${ytId}?enablejsapi=1&modestbranding=1&rel=0&controls=1&iv_load_policy=3&cc_load_policy=0&fs=1&playsinline=1`;
  }

  // Dropbox
  if (url.includes('dropbox.com')) {
    return url.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '?dl=1');
  }

  return url;
};

const getThumbnailUrl = (url: string) => {
  const ytId = getYouTubeEmbedId(url);
  if (ytId) return `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;

  // If it's a direct mp4, we can't easily get a mid frame client side, 
  // but we can at least return the URL if the browser supports it as a cover (rarely works well).
  return null;
};

const isValidVideoUrl = (url: string) => {
  if (!url) return false;
  const supportedDomains = [
    'youtube.com',
    'youtu.be',
    'drive.google.com',
    'dropbox.com',
    'vimeo.com',
    'cloudinary.com'
  ];

  const isSupportedDomain = supportedDomains.some(domain => url.toLowerCase().includes(domain));
  const isDirectVideo = /\.(mp4|webm|ogg|mov)$/i.test(url);

  return isSupportedDomain || isDirectVideo;
};

// --- App Component ---

// --- Google API Utilities ---
const GAPI_CLIENT_ID = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID as string | undefined;
const GAPI_API_KEY = (import.meta as any).env?.VITE_GOOGLE_API_KEY as string | undefined;

declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}

function loadGapiIfNeeded(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.gapi?.client) return resolve();
    if (!window.gapi) return reject(new Error('Google API script not loaded'));
    window.gapi.load('client:auth2:picker', {
      callback: resolve,
      onerror: reject,
    });
  });
}

async function getAccessToken(scope: string): Promise<string> {
  if (!GAPI_CLIENT_ID) throw new Error('Missing VITE_GOOGLE_CLIENT_ID in .env');
  await loadGapiIfNeeded();
  const authInstance = window.gapi.auth2.getAuthInstance();
  if (!authInstance) {
    await window.gapi.auth2.init({ client_id: GAPI_CLIENT_ID, scope });
  }
  const user = await window.gapi.auth2.getAuthInstance().signIn({ scope });
  return user.getAuthResponse().access_token;
}

interface DrivePickResult {
  fileId: string;
  name: string;
  thumbnailUrl?: string;
  mimeType: string;
}

function openDrivePicker(accessToken: string): Promise<DrivePickResult | null> {
  return new Promise((resolve) => {
    if (!GAPI_API_KEY) { alert('Missing VITE_GOOGLE_API_KEY in .env'); resolve(null); return; }
    const picker = new window.google.picker.PickerBuilder()
      .addView(new window.google.picker.View(window.google.picker.ViewId.DOCS_VIDEOS))
      .setOAuthToken(accessToken)
      .setDeveloperKey(GAPI_API_KEY)
      .setCallback((data: any) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const doc = data.docs[0];
          resolve({
            fileId: doc.id,
            name: doc.name,
            thumbnailUrl: doc.thumbnailLink ?? undefined,
            mimeType: doc.mimeType,
          });
        } else if (data.action === window.google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

async function checkDriveFileExists(fileId: string): Promise<boolean> {
  if (!GAPI_API_KEY) return true; // Can't check, assume fine
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=trashed&key=${GAPI_API_KEY}`
    );
    if (!res.ok) return false; // 404 = deleted
    const data = await res.json();
    return !data.trashed;
  } catch {
    return true; // Network error: assume OK
  }
}

async function uploadToDriveViaYouTube(
  fileId: string,
  videoTitle: string,
  accessToken: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  // Step 1: Get the Drive file download URL (streamed via fetch with user's token)
  const driveRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!driveRes.ok) throw new Error('Could not download Drive file. Check permissions.');
  const blob = await driveRes.blob();
  onProgress?.(20);

  // Step 2: Initialize resumable YouTube upload
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': blob.type,
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify({
        snippet: { title: videoTitle, description: 'Uploaded via VinReview' },
        status: { privacyStatus: 'unlisted' },
      }),
    }
  );
  if (!initRes.ok) throw new Error('YouTube upload init failed. Ensure YouTube Data API is enabled.');
  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) throw new Error('No upload URL from YouTube.');
  onProgress?.(30);

  // Step 3: Upload the blob
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
  if (!uploadRes.ok) throw new Error('YouTube file upload failed.');
  const videoData = await uploadRes.json();
  onProgress?.(100);

  const ytVideoId = videoData.id;
  return `https://www.youtube.com/embed/${ytVideoId}?enablejsapi=1&modestbranding=1&rel=0&controls=1&playsinline=1`;
}
// --- /Google API Utilities ---

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentView, setCurrentView] = useState<'dashboard' | 'upload' | 'review'>('dashboard');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);

  // Persistence & Migration
  useEffect(() => {
    const init = async () => {
      const savedInDB = await getProjects();
      const savedInLocal = localStorage.getItem('vinreview_projects');

      if (savedInLocal && savedInDB.length === 0) {
        // Migration: move from localStorage to IndexedDB
        try {
          const migrated = JSON.parse(savedInLocal);
          // Auto-clean: Remove ANY project older than 7 days during migration
          const filtered = migrated.filter((p: Project) => {
            const isOld = Date.now() - p.createdAt > 1000 * 60 * 60 * 24 * 7; // 7 days
            return !isOld;
          });
          setProjects(filtered);
          await saveProjects(filtered);
          clearLocalStorage();
          console.log('Migration and initial clean successful');
        } catch (err) {
          console.error('Migration failed', err);
        }
      } else {
        // Daily house-keeping on existing IndexedDB data
        // Remove ANY project older than 7 days to keep storage lean
        const healthy = savedInDB.filter((p: Project) => {
          const isOld = Date.now() - p.createdAt > 1000 * 60 * 60 * 24 * 7; // 7 days
          return !isOld;
        });
        setProjects(healthy);
      }
      setIsInitialLoading(false);
    };
    init();
  }, []);

  useEffect(() => {
    if (!isInitialLoading) {
      saveProjects(projects);
    }
  }, [projects, isInitialLoading]);

  // Hash-based routing
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#/review/')) {
        const id = hash.replace('#/review/', '');
        setActiveProjectId(id);
        setCurrentView('review');
      } else if (hash === '#/upload') {
        setCurrentView('upload');
      } else {
        setCurrentView('dashboard');
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();

    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const addProject = (name: string, videoUrl: string, meta?: Partial<Project>) => {
    const newProject: Project = {
      id: nanoid(),
      name,
      videoUrl,
      fileId: meta?.fileId,
      sourceType: meta?.sourceType,
      thumbnailUrl: meta?.thumbnailUrl,
      videoDuration: meta?.videoDuration,
      comments: [],
      isApproved: false,
      createdAt: Date.now(),
    };
    setProjects(prev => [newProject, ...prev]);
    window.location.hash = `#/review/${newProject.id}`;
  };

  const addComment = (projectId: string, comment: Partial<Comment>) => {
    setProjects(prev => prev.map(p => {
      if (p.id === projectId) {
        // Derive type from content
        const hasText = !!comment.text?.trim();
        const hasAudio = !!comment.audioUrl;
        const hasDrawing = !!comment.drawing?.paths?.length;
        const typeCount = [hasText, hasAudio, hasDrawing].filter(Boolean).length;
        const type: CommentType = typeCount > 1 ? 'combined'
          : hasAudio ? 'audio'
            : hasDrawing ? 'drawing'
              : 'text';
        const newComment: Comment = {
          id: nanoid(),
          timestamp: comment.timestamp || 0,
          type,
          text: comment.text,
          audioUrl: comment.audioUrl,
          drawing: comment.drawing,
          createdAt: Date.now(),
          resolved: false,
        };
        return {
          ...p,
          comments: [...p.comments, newComment].sort((a, b) => a.timestamp - b.timestamp)
        };
      }
      return p;
    }));
  };

  const toggleCommentResolution = (projectId: string, commentId: string) => {
    setProjects(prev => prev.map(p => {
      if (p.id === projectId) {
        return {
          ...p,
          comments: p.comments.map(c =>
            c.id === commentId ? { ...c, resolved: !c.resolved } : c
          )
        };
      }
      return p;
    }));
  };

  const toggleApproval = (projectId: string) => {
    setProjects(prev => prev.map(p => {
      if (p.id === projectId) return { ...p, isApproved: !p.isApproved };
      return p;
    }));
  };

  const deleteProject = (id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
  };

  const activeProject = projects.find(p => p.id === activeProjectId);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0A0A0A] text-white font-sans selection:bg-orange-500/30 flex flex-col">
      <AnimatePresence mode="wait">
        {isInitialLoading ? (
          <div className="flex flex-col items-center justify-center h-screen space-y-4">
            <RefreshCw size={40} className="animate-spin text-orange-500" />
            <p className="text-zinc-500 font-bold uppercase tracking-widest text-xs">Loading Workstation...</p>
          </div>
        ) : (
          <>
            {currentView === 'dashboard' && (
              <DashboardView
                key="dashboard"
                projects={projects}
                onDelete={deleteProject}
              />
            )}
            {currentView === 'upload' && (
              <UploadView key="upload" onUpload={addProject} />
            )}
            {currentView === 'review' && activeProject && (
              <ReviewView
                key={`review-${activeProject.id}`}
                project={activeProject}
                onAddComment={(comment) => addComment(activeProject.id, comment)}
                onApprove={() => toggleApproval(activeProject.id)}
                onToggleCommentResolution={(commentId) => toggleCommentResolution(activeProject.id, commentId)}
                onUpdateProject={(updates) => setProjects(prev => prev.map(p => p.id === activeProject.id ? { ...p, ...updates } : p))}
              />
            )}
            {currentView === 'review' && !activeProject && (
              <div key="not-found" className="flex flex-col items-center justify-center h-screen p-6 text-center">
                <h2 className="text-2xl font-bold mb-4">Project Not Found</h2>
                <a href="#/" className="bg-white text-black px-6 py-3 rounded-full font-bold">Back to Dashboard</a>
              </div>
            )}
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Dashboard View ---
function DashboardView({ projects, onDelete }: { projects: Project[], onDelete: (id: string) => void }) {
  const [missingIds, setMissingIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'most-comments' | 'least-comments'>('newest');

  // On mount: silently check if Drive files still exist (Throttled)
  useEffect(() => {
    const driveProjects = projects.filter(p => p.fileId);
    if (!driveProjects.length) return;

    // Run health checks with a small sequential delay to avoid hitting rate limits or blocking the UI
    const runChecks = async () => {
      for (const p of driveProjects) {
        const exists = await checkDriveFileExists(p.fileId!);
        if (!exists) setMissingIds(prev => [...prev, p.id]);
        // Wait 100ms between checks
        await new Promise(r => setTimeout(r, 100));
      }
    };
    runChecks();
  }, []);

  const filteredAndSortedProjects = projects
    .filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'newest') return b.createdAt - a.createdAt;
      if (sortBy === 'oldest') return a.createdAt - b.createdAt;
      if (sortBy === 'most-comments') return b.comments.length - a.comments.length;
      if (sortBy === 'least-comments') return a.comments.length - b.comments.length;
      return 0;
    });

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.04, duration: 0.15 }
    }
  };

  const item = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0, transition: { duration: 0.15 } }
  };

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={container}
      className="h-full flex flex-col max-w-7xl mx-auto w-full p-6 pt-6 lg:pt-10 overflow-hidden"
    >
      <header className="flex flex-col sm:flex-row items-center justify-between mb-12 gap-6">
        <motion.div variants={item} className="flex flex-col items-center sm:items-start text-center sm:text-left">
          <h1 className="text-3xl lg:text-4xl font-black tracking-tighter italic uppercase text-transparent bg-clip-text bg-gradient-to-br from-orange-500 to-amber-600 leading-[1.1] py-1 pr-4">VinReview</h1>
          <div className="text-zinc-500 text-[10px] font-bold uppercase tracking-[0.3em] mt-2 flex items-center gap-2">
            <div className="w-12 h-[2px] bg-zinc-800" />
            Video Collaboration Hub
          </div>
        </motion.div>
        <motion.div variants={item}>
          <a
            href="#/upload"
            className="group relative bg-white text-black px-6 py-2.5 rounded-xl font-black italic uppercase tracking-tighter text-xs lg:text-sm flex items-center justify-center gap-2 transition-all hover:scale-105 active:scale-95 shadow-xl shadow-orange-500/10 overflow-hidden"
          >
            <Plus size={16} strokeWidth={3} className="relative z-10" />
            <span className="relative z-10">New Project</span>
            <div className="absolute inset-0 bg-zinc-100 translate-y-full group-hover:translate-y-0 transition-transform duration-200" />
          </a>
        </motion.div>
      </header>

      {/* Search & Sort Bar */}
      {projects.length > 0 && (
        <motion.div
          variants={item}
          className="flex flex-col sm:flex-row items-center gap-4 mb-8 bg-zinc-900/20 border border-zinc-800/40 p-2 rounded-2xl backdrop-blur-md"
        >
          <div className="relative flex-1 w-full">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-600" />
            <input
              type="text"
              placeholder="Search projects..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full bg-zinc-950/40 border border-transparent focus:border-orange-500/30 rounded-xl py-2.5 pl-11 pr-4 text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none transition-all"
            />
          </div>
          <div className="flex items-center gap-2 bg-zinc-950/40 p-1 rounded-xl border border-zinc-800/50 w-full sm:w-auto">
            <div className="flex items-center gap-1.5 px-3 text-zinc-500">
              <Filter size={14} />
              <span className="text-[10px] font-black uppercase tracking-widest leading-none">Sort</span>
            </div>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as any)}
              className="bg-transparent text-zinc-300 text-[10px] font-black uppercase tracking-widest py-1.5 pr-8 pl-1 focus:outline-none cursor-pointer appearance-none"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='currentColor'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='Length 19 9l-7 7-7-7' /%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.5rem center', backgroundSize: '1em' }}
            >
              <option value="newest" className="bg-zinc-900">Newest</option>
              <option value="oldest" className="bg-zinc-900">Oldest</option>
              <option value="most-comments" className="bg-zinc-900">Most Comments</option>
              <option value="least-comments" className="bg-zinc-900">Least Comments</option>
            </select>
          </div>
        </motion.div>
      )}

      <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar pb-10">
        {projects.length > 0 && filteredAndSortedProjects.length === 0 ? (
          <motion.div
            variants={item}
            className="border border-zinc-800/50 rounded-2xl p-12 text-center bg-zinc-900/10 backdrop-blur-sm relative overflow-hidden"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-orange-500/5 to-transparent opacity-50" />
            <div className="relative z-10">
              <Search size={32} className="text-zinc-700 mx-auto mb-4" />
              <h3 className="text-xl font-black italic uppercase tracking-tight mb-2">No projects match your search</h3>
              <p className="text-zinc-500 text-sm font-medium mb-4">Try a different search term or clear the filter.</p>
              <button
                onClick={() => setSearchTerm('')}
                className="text-orange-500 text-[10px] font-black uppercase tracking-widest hover:underline px-4 py-2 bg-orange-500/10 rounded-lg border border-orange-500/20 transition-all hover:bg-orange-500 hover:text-white"
              >
                Clear Search
              </button>
            </div>
          </motion.div>
        ) : projects.length === 0 ? (
          <motion.div
            variants={item}
            className="border border-zinc-800/50 rounded-2xl p-24 text-center bg-zinc-900/10 backdrop-blur-sm relative overflow-hidden"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-orange-500/5 to-transparent opacity-50" />
            <div className="relative z-10">
              <a
                href="#/upload"
                className="w-24 h-24 bg-zinc-900 border border-zinc-800 rounded-full flex items-center justify-center mx-auto mb-8 shadow-2xl transition-all hover:scale-110 hover:border-orange-500/50 hover:bg-zinc-800 group"
              >
                <Plus size={44} className="text-zinc-700 group-hover:text-orange-500 transition-colors" />
              </a>
              <h2 className="text-3xl font-black italic uppercase tracking-tight mb-3">Your desk is empty</h2>
              <p className="text-zinc-500 max-w-sm mx-auto font-medium">Create your first project to start receiving frame-accurate feedback from your team.</p>
            </div>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredAndSortedProjects.map(project => {
              const isMissing = missingIds.includes(project.id);
              const thumb = project.thumbnailUrl || getThumbnailUrl(project.videoUrl);
              return (
                <motion.div
                  key={project.id}
                  variants={item}
                  whileHover={{ y: -3, transition: { duration: 0.1 } }}
                  className="group bg-zinc-900/40 border border-zinc-800/50 p-4 rounded-2xl flex flex-col justify-between gap-4 transition-colors hover:border-orange-500/30 hover:bg-zinc-900/60 relative overflow-hidden"
                >
                  {project.isApproved && (
                    <div className="absolute top-0 right-0 bg-green-600 text-white text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-bl-lg flex items-center gap-1">
                      <Check size={10} strokeWidth={4} />
                      Approved
                    </div>
                  )}

                  <div>
                    <div className="w-full aspect-video bg-zinc-950 rounded-lg mb-3 overflow-hidden border border-zinc-800/50 group-hover:border-orange-500/20 transition-colors relative">
                      {thumb ? (
                        <>
                          <img
                            src={thumb}
                            className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500 opacity-60 group-hover:opacity-100"
                            alt={project.name}
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                        </>
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-zinc-800 to-zinc-950 flex items-center justify-center group-hover:scale-105 transition-transform duration-200">
                          <Play size={28} className="text-zinc-700 group-hover:text-orange-500/50 transition-colors" />
                        </div>
                      )}
                      {/* Source Missing Overlay */}
                      {isMissing && (
                        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2 backdrop-blur-sm">
                          <XCircle size={28} className="text-red-400" />
                          <span className="text-[10px] font-black uppercase tracking-widest text-red-400">Source Missing</span>
                          <span className="text-[9px] text-zinc-500 text-center px-4">The Drive file was deleted or moved. Thumbnail cached.</span>
                        </div>
                      )}
                      {!isMissing && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-12 h-12 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border border-white/20 group-hover:scale-110 group-hover:bg-orange-500 group-hover:border-orange-400 transition-all">
                            <Play size={20} className="text-white fill-white ml-1" />
                          </div>
                        </div>
                      )}
                    </div>
                    <h3 className="text-base font-black italic uppercase tracking-tighter group-hover:text-orange-500 transition-colors line-clamp-1">
                      {project.name}
                    </h3>
                    <p className="text-[9px] text-zinc-600 font-bold uppercase tracking-widest mt-0.5">
                      {project.comments.length} comments · {new Date(project.createdAt).toLocaleDateString()}
                      {project.sourceType === 'drive' && <span className="ml-2 text-blue-500">· Drive</span>}
                      {project.sourceType === 'youtube' && <span className="ml-2 text-red-500">· YouTube</span>}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 pt-3 border-t border-zinc-800/30">
                    <a
                      href={`#/review/${project.id}`}
                      className="flex-1 bg-zinc-900 border border-zinc-700 hover:border-orange-500/50 hover:bg-orange-500/10 hover:text-orange-400 text-zinc-200 py-2.5 rounded-lg font-black italic uppercase tracking-tighter text-[10px] text-center transition-all flex items-center justify-center gap-1.5"
                    >
                      <ExternalLink size={13} />
                      Open Review
                    </a>
                    <button
                      onClick={() => {
                        const url = `${window.location.origin}${window.location.pathname}#/review/${project.id}`;
                        navigator.clipboard.writeText(url).then(() => alert('Link copied!')).catch(() => alert('Link copied!'));
                      }}
                      className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-700 hover:border-blue-500/50 hover:bg-blue-500/10 hover:text-blue-400 transition-all text-zinc-400"
                      title="Copy Link"
                    >
                      <Share2 size={15} />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm('Delete this project?')) onDelete(project.id);
                      }}
                      className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-700 hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-400 transition-all text-zinc-400"
                      title="Delete"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}


// --- Upload View ---
function UploadView({ onUpload }: { onUpload: (name: string, url: string, meta?: Partial<Project>) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [pickerLoading, setPickerLoading] = useState(false);
  const [driveFile, setDriveFile] = useState<{ fileId: string; thumbnailUrl?: string } | null>(null);

  const handleDrivePick = async () => {
    setPickerLoading(true);
    setError('');
    try {
      const token = await getAccessToken('https://www.googleapis.com/auth/drive.readonly');
      const result = await openDrivePicker(token);
      if (result) {
        const driveUrl = `https://drive.google.com/file/d/${result.fileId}/view`;
        setName(result.name.replace(/\.[^/.]+$/, '')); // strip extension
        setUrl(driveUrl);
        setDriveFile({ fileId: result.fileId, thumbnailUrl: result.thumbnailUrl });
      }
    } catch (err: any) {
      setError(err.message || 'Failed to open Drive Picker. Check your API credentials.');
    } finally {
      setPickerLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Please enter a project name.');
      return;
    }

    if (!url.trim()) {
      setError('Please provide a video URL.');
      return;
    }

    if (!isValidVideoUrl(url)) {
      setError('Unsupported video link. Please use YouTube, Google Drive, or a direct video link.');
      return;
    }

    const meta: Partial<Project> = driveFile
      ? { fileId: driveFile.fileId, thumbnailUrl: driveFile.thumbnailUrl, sourceType: 'drive' }
      : { sourceType: url.includes('youtube.com') || url.includes('youtu.be') ? 'youtube' : 'direct' };

    onUpload(name, transformVideoUrl(url), meta);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="h-full flex flex-col max-w-2xl mx-auto w-full p-6 pt-6 lg:pt-12 overflow-y-auto overflow-x-hidden custom-scrollbar"
    >
      <a href="#/" className="inline-flex items-center gap-2 text-zinc-500 hover:text-orange-500 mb-12 transition-all font-bold uppercase tracking-widest text-xs group">
        <ChevronLeft size={20} className="group-hover:-translate-x-1 transition-transform" />
        Back to Dashboard
      </a>

      <div className="bg-zinc-900/40 border border-zinc-800/50 p-8 lg:p-12 rounded-2xl shadow-2xl backdrop-blur-xl relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-orange-500 to-amber-500" />

        <h2 className="text-4xl lg:text-5xl font-black italic uppercase tracking-tighter mb-2 leading-none">Create Review</h2>
        <p className="text-zinc-500 mb-8 font-medium text-sm lg:text-base">Generate a secure link for your client to leave feedback.</p>

        {/* Drive Picker Button */}
        {GAPI_CLIENT_ID && (
          <button
            type="button"
            onClick={handleDrivePick}
            disabled={pickerLoading}
            className="w-full mb-6 flex items-center justify-center gap-3 bg-blue-600/10 hover:bg-blue-600/20 border border-blue-500/30 hover:border-blue-500/60 text-blue-400 py-4 rounded-xl font-black uppercase tracking-widest text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pickerLoading ? (
              <RefreshCw size={18} className="animate-spin" />
            ) : driveFile ? (
              <CheckCircle2 size={18} className="text-green-400" />
            ) : (
              <Video size={18} />
            )}
            {pickerLoading ? 'Opening Picker...' : driveFile ? 'Drive File Selected ✓ — Change' : '📁 Pick from Google Drive'}
          </button>
        )}

        {driveFile && (
          <div className="mb-6 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl text-xs text-blue-400 font-bold uppercase tracking-widest flex items-center gap-2">
            <CheckCircle2 size={14} />
            Drive file auto-filled below — edit name if needed, then Generate
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-zinc-500 ml-1">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={e => {
                setName(e.target.value);
                if (error) setError('');
              }}
              placeholder="e.g. Beast Burger V2 Final Cut"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-4 focus:outline-none focus:border-orange-500/50 focus:ring-4 focus:ring-orange-500/5 transition-all text-white text-base font-medium placeholder:text-zinc-700"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-zinc-500 ml-1">Video URL</label>
            <input
              type="url"
              value={url}
              onChange={e => {
                setUrl(e.target.value);
                if (error) setError('');
              }}
              placeholder="YouTube, Drive, or direct MP4 link"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-4 focus:outline-none focus:border-orange-500/50 focus:ring-4 focus:ring-orange-500/5 transition-all text-white text-base font-medium placeholder:text-zinc-700"
              required
            />

            <AnimatePresence mode="wait">
              {error ? (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2 mt-2"
                >
                  <XCircle size={14} className="text-red-500 shrink-0" />
                  <p className="text-[11px] text-red-500 font-bold uppercase tracking-wider">{error}</p>
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col gap-1.5 px-1 pt-2"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-orange-500/50 animate-pulse" />
                    <p className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider italic">YouTube & Drive links supported</p>
                  </div>
                  <p className="text-[9px] text-zinc-600 font-medium uppercase tracking-widest ml-3">Ensure Drive sharing is set to "Anyone with the link can view"</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <button
            type="submit"
            className="w-full bg-orange-500 hover:bg-orange-600 text-white py-5 rounded-xl font-black italic uppercase tracking-tighter text-xl transition-all active:scale-[0.98] shadow-2xl shadow-orange-500/20 flex items-center justify-center gap-3 group overflow-hidden relative"
          >
            <span className="relative z-10">Generate Review Link</span>
            <Send size={20} className="relative z-10 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
          </button>
        </form>
      </div>
    </motion.div>
  );
}

// --- Drawing Overlay Component (multi-stroke) ---
function DrawingOverlay({
  isActive,
  onSave,
  onCancel
}: {
  isActive: boolean;
  onSave: (drawing: DrawingData) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [paths, setPaths] = useState<DrawingPath[]>([]);
  const [currentPoints, setCurrentPoints] = useState<{ x: number; y: number }[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const COLOR = '#f97316';
  const WIDTH = 4;

  useEffect(() => {
    if (!isActive) {
      setPaths([]);
      setCurrentPoints([]);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }, [isActive]);

  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? (e as React.TouchEvent).touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? (e as React.TouchEvent).touches[0].clientY : (e as React.MouseEvent).clientY;
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height
    };
  };

  const redrawCanvas = (allPaths: DrawingPath[], inProgressPoints: { x: number; y: number }[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const drawPath = (points: { x: number; y: number }[], color: string, width: number) => {
      if (points.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(points[0].x * W, points[0].y * H);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x * W, points[i].y * H);
      }
      ctx.stroke();
    };

    allPaths.forEach(p => drawPath(p.points, p.color, p.width));
    if (inProgressPoints.length > 1) drawPath(inProgressPoints, COLOR, WIDTH);
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isActive) return;
    e.preventDefault();
    const pos = getPos(e);
    setIsDrawing(true);
    setCurrentPoints([pos]);
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || !isActive) return;
    e.preventDefault();
    const pos = getPos(e);
    const newPoints = [...currentPoints, pos];
    setCurrentPoints(newPoints);
    redrawCanvas(paths, newPoints);
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    if (currentPoints.length > 1) {
      // Simplify path: skip points that are too close to reduce data size
      const simplified = [currentPoints[0]];
      let lastPoint = currentPoints[0];
      for (let i = 1; i < currentPoints.length - 1; i++) {
        const p = currentPoints[i];
        const dist = Math.hypot(p.x - lastPoint.x, p.y - lastPoint.y);
        if (dist > 0.003) { // Threshold: 0.3% of canvas dimensions
          simplified.push(p);
          lastPoint = p;
        }
      }
      simplified.push(currentPoints[currentPoints.length - 1]);

      const newPath: DrawingPath = { points: simplified, color: COLOR, width: WIDTH };
      const newPaths = [...paths, newPath];
      setPaths(newPaths);
      setCurrentPoints([]);
      redrawCanvas(newPaths, []);
    }
  };

  const handleClear = () => {
    setPaths([]);
    setCurrentPoints([]);
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  if (!isActive) return null;

  return (
    <div className="absolute inset-0 z-30 cursor-crosshair touch-none">
      <canvas
        ref={canvasRef}
        width={1200}
        height={675}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
        onTouchStart={startDrawing}
        onTouchMove={draw}
        onTouchEnd={stopDrawing}
        className="w-full h-full"
      />
      <div className="absolute bottom-4 right-4 flex gap-2">
        {paths.length > 0 && (
          <button
            onClick={handleClear}
            className="bg-zinc-800/90 backdrop-blur-sm px-3 py-2 rounded-full text-zinc-400 text-xs font-bold uppercase tracking-wider hover:text-white transition-colors"
          >
            Clear
          </button>
        )}
        <button
          onClick={onCancel}
          className="bg-zinc-900/80 p-3 rounded-full text-white backdrop-blur-sm"
        >
          <X size={20} />
        </button>
        <button
          onClick={() => { if (paths.length > 0) onSave({ paths }); else onCancel(); }}
          className="bg-orange-500 p-3 rounded-full text-white shadow-lg disabled:opacity-40"
        >
          <Send size={20} />
        </button>
      </div>
    </div>
  );
}

// --- Audio Recorder Component ---
function AudioRecorder({
  onSave,
  onCancel
}: {
  onSave: (url: string) => void;
  onCancel: () => void;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const startRecording = async () => {
    try {
      if (typeof MediaRecorder === 'undefined') {
        throw new Error("Recording not supported on this device/browser.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Determine supported MIME type for mobile (especially Safari/iOS)
      const mimeType = [
        'audio/webm',
        'audio/mp4',
        'audio/ogg',
        'audio/wav'
      ].find(type => MediaRecorder.isTypeSupported(type)) || '';

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        // Use the actual mimeType from the recorder
        const actualType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: actualType });

        // Convert Blob to Base64 to allow persistence in localStorage
        // This is key for mobile "saving" as blob: URLs are destroyed on refresh
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Audio = reader.result as string;
          onSave(base64Audio);
        };
        reader.readAsDataURL(blob);

        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start();
      setIsRecording(true);
      timerRef.current = window.setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err: any) {
      console.error("Microphone access denied or unsupported", err);
      alert(err.message === "Recording not supported on this device/browser."
        ? err.message
        : "Please allow microphone access to record audio feedback. Note: Most browsers require HTTPS for microphone access.");
      onCancel();
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  useEffect(() => {
    startRecording();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <div className="bg-zinc-900 border border-zinc-700 p-4 rounded-3xl shadow-2xl flex flex-col items-center gap-3 w-full max-w-xs mx-auto">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-red-500 rounded-full flex items-center justify-center animate-pulse">
          <Mic size={20} className="text-white" />
        </div>
        <div className="text-xl font-mono font-bold">
          {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
        </div>
      </div>
      <p className="text-zinc-500 text-[10px] font-bold uppercase tracking-widest">Recording audio...</p>
      <div className="flex gap-2 w-full mt-1">
        <button
          onClick={onCancel}
          className="flex-1 py-2 rounded-xl bg-zinc-800 font-bold text-zinc-400 text-xs"
        >
          Cancel
        </button>
        <button
          onClick={stopRecording}
          className="flex-1 py-2 rounded-xl bg-white text-black font-bold text-xs"
        >
          Stop
        </button>
      </div>
    </div>
  );
}

// --- Review View (Adaptive & Mobile-First) ---
function ReviewView({
  project,
  onAddComment,
  onApprove,
  onToggleCommentResolution,
  onUpdateProject
}: {
  project: Project,
  onAddComment: (comment: Partial<Comment>) => void,
  onApprove: () => void,
  onToggleCommentResolution: (commentId: string) => void,
  onUpdateProject: (updates: Partial<Project>) => void
}) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showApprovedState, setShowApprovedState] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unresolved' | 'resolved'>('all');
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [ytSyncState, setYtSyncState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [ytSyncProgress, setYtSyncProgress] = useState(0);
  const playerRef = useRef<any>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const commentsEndRef = useRef<HTMLDivElement>(null);
  const commentRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const isYouTubeEmbed = project.videoUrl.includes('youtube.com/embed/');
  const isDriveEmbed = project.videoUrl.includes('drive.google.com') || project.videoUrl.includes('docs.google.com');
  // We only use the specialized iframe logic for YouTube because it has a postMessage API.
  // Google Drive preview iframes don't, so we now force them to use ReactPlayer for control sync.
  const isEmbedVideo = isYouTubeEmbed;
  const [hoveredComment, setHoveredComment] = useState<string | null>(null);
  const [highlightedComment, setHighlightedComment] = useState<string | null>(null);
  const [hiddenDrawingIds, setHiddenDrawingIds] = useState<string[]>([]);

  // Unified comment composer state
  const [isComposing, setIsComposing] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [pendingAudio, setPendingAudio] = useState<string | null>(null);
  const [pendingDrawing, setPendingDrawing] = useState<DrawingData | null>(null);
  const [showDrawingMode, setShowDrawingMode] = useState(false);
  const [showAudioMode, setShowAudioMode] = useState(false);
  const [activeComposerTab, setActiveComposerTab] = useState<'text' | 'audio' | 'drawing'>('text');
  const [timelineZoom, setTimelineZoom] = useState(1);
  const timelineContainerRef = useRef<HTMLDivElement>(null);

  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // YouTube iframe API bridge via postMessage
  useEffect(() => {
    if (!isYouTubeEmbed) return;

    // Listen for messages from the YouTube iframe
    const handleMessage = (event: MessageEvent) => {
      if (!event.origin.includes('youtube.com')) return;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data.event === 'infoDelivery' && data.info) {
          if (typeof data.info.currentTime === 'number') {
            setCurrentTime(data.info.currentTime);
          }
          if (typeof data.info.duration === 'number' && data.info.duration > 0) {
            setDuration(data.info.duration);
          }
          if (typeof data.info.playerState === 'number') {
            setPlaying(data.info.playerState === 1); // 1 = playing
          }
        }
        if (data.event === 'onReady') {
          // Subscribe to info delivery at 250ms intervals
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({ event: 'listening', id: 1 }),
            '*'
          );
        }
      } catch { }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isYouTubeEmbed]);

  // Sync playing state with HTML5 video element
  useEffect(() => {
    if (isYouTubeEmbed || !playerRef.current) return;

    if (playing) {
      playerRef.current.play().catch(err => {
        console.error("Playback failed:", err);
        setPlaying(false);
      });
    } else {
      playerRef.current.pause();
    }
  }, [playing, isYouTubeEmbed, project.videoUrl]); // Re-sync if project video changes

  const filteredComments = project.comments.filter(c => {
    if (filter === 'unresolved') return !c.resolved;
    if (filter === 'resolved') return c.resolved;
    return true;
  });

  const handleProgress = (state: { playedSeconds: number }) => {
    setCurrentTime(state.playedSeconds);
  };

  const handleSeek = (time: number) => {
    // Preserve current play/pause state — do NOT force play
    if (isYouTubeEmbed && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'seekTo', args: [time, true] }),
        '*'
      );
      if (playing) {
        setTimeout(() => {
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({ event: 'command', func: 'playVideo', args: [] }),
            '*'
          );
        }, 100);
      }
    } else if (playerRef.current) {
      // Standard HTML5 Video seeking
      playerRef.current.currentTime = time;
    }
    setCurrentTime(time);
    // NOTE: do NOT call setPlaying() here — preserve existing state
  };


  const handleApprove = () => {
    const nextState = !project.isApproved;
    onApprove();
    if (nextState) {
      setShowApprovedState(true);
      setTimeout(() => setShowApprovedState(false), 3000);
    }
  };

  const handleShare = async () => {
    const shareData = {
      title: `Review: ${project.name}`,
      text: `Check out this video review for ${project.name}`,
      url: window.location.href,
    };

    const isDesktop = !(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent));

    try {
      if (navigator.share && !isDesktop) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(window.location.href);
        alert('Review link copied to clipboard!');
      }
    } catch (err) {
      console.error('Error sharing:', err);
    }
  };

  const handleTimelineInteraction = (e: React.MouseEvent | React.TouchEvent) => {
    if (!timelineContainerRef.current) return;
    const rect = timelineContainerRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? (e as React.TouchEvent).touches[0].clientX : (e as React.MouseEvent).clientX;
    const scrollLeft = timelineContainerRef.current.parentElement?.scrollLeft || 0;
    const x = clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));
    const rawTime = percent * duration;

    // Snap to nearest visible comment dot within 2% of visible range (not total duration)
    const visibleDuration = duration / timelineZoom;
    const snapThreshold = visibleDuration * 0.02;
    const visibleComments = project.comments.filter(c => {
      if (filter === 'unresolved') return !c.resolved;
      if (filter === 'resolved') return c.resolved;
      return true;
    });
    const nearest = visibleComments.reduce<{ c: typeof project.comments[0] | null; dist: number }>(
      (acc, c) => {
        const dist = Math.abs(c.timestamp - rawTime);
        return dist < acc.dist ? { c, dist } : acc;
      },
      { c: null, dist: Infinity }
    );
    const snapTime = nearest.c && nearest.dist < snapThreshold ? nearest.c.timestamp : rawTime;
    handleSeek(snapTime);
  };

  const scrollToComment = (commentId: string) => {
    setHighlightedComment(commentId);
    setTimeout(() => {
      commentRefs.current[commentId]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    setTimeout(() => setHighlightedComment(null), 2000);
  };

  // Seek + scroll to comment, preserving play state
  const seekToComment = (comment: typeof project.comments[0]) => {
    handleSeek(comment.timestamp);
    scrollToComment(comment.id);
    // Auto-visible for 1s by default; no persistent selection pinning
  };

  const [showIframeFallback, setShowIframeFallback] = useState(false);

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex flex-col h-screen w-full relative overflow-hidden bg-[#050505]",
        "lg:flex-row",
        isFullscreen && "p-0",
        showDrawingMode && "drawing-mode-active"
      )}
    >
      <style>{`
        .drawing-mode-active header { transform: translateY(-100%); opacity: 0; pointer-events: none; }
        .drawing-mode-active aside { transform: translateX(100%); opacity: 0; pointer-events: none; width: 0 !important; min-width: 0 !important; }
        .drawing-mode-active .fixed.lg\\:hidden { opacity: 0.2; pointer-events: none; }
        header, aside { transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
      `}</style>
      {/* Header Bar */}
      <header className="absolute top-0 left-0 right-0 h-16 bg-zinc-950/50 backdrop-blur-xl border-b border-white/5 z-50 flex items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <a href="#/" className="p-2 hover:bg-white/10 rounded-lg transition-colors text-zinc-400 hover:text-white">
            <ChevronLeft size={20} />
          </a>
          <div>
            <h2 className="text-sm font-black italic uppercase tracking-wider text-orange-500 leading-none">{project.name}</h2>
            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-[0.2em] mt-1">Reviewing Stage</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Unlock Timeline Button for Drive videos */}
          {project.sourceType === 'drive' && project.fileId && GAPI_CLIENT_ID && (
            <button
              onClick={async () => {
                if (!confirm('This will upload the video as Unlisted to YOUR YouTube channel. Continue?')) return;
                setYtSyncState('loading');
                setYtSyncProgress(0);
                try {
                  const token = await getAccessToken(
                    'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/drive.readonly'
                  );
                  const ytUrl = await uploadToDriveViaYouTube(
                    project.fileId!,
                    project.name,
                    token,
                    (pct) => setYtSyncProgress(pct)
                  );
                  onUpdateProject({ videoUrl: ytUrl, sourceType: 'youtube' });
                  setYtSyncState('done');
                  setTimeout(() => setYtSyncState('idle'), 4000);
                } catch (err: any) {
                  console.error('YouTube sync failed:', err);
                  alert('YouTube sync failed: ' + err.message);
                  setYtSyncState('error');
                  setTimeout(() => setYtSyncState('idle'), 4000);
                }
              }}
              disabled={ytSyncState === 'loading'}
              className={cn(
                'hidden sm:flex items-center gap-2 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all border',
                ytSyncState === 'done'
                  ? 'bg-green-600/20 border-green-500/40 text-green-400'
                  : ytSyncState === 'error'
                    ? 'bg-red-600/20 border-red-500/40 text-red-400'
                    : 'bg-blue-600/10 border-blue-500/30 text-blue-400 hover:bg-blue-600/20 hover:border-blue-500/60'
              )}
              title="Upload to your YouTube as Unlisted to unlock full timeline"
            >
              {ytSyncState === 'loading' ? (
                <><RefreshCw size={13} className="animate-spin" /> {ytSyncProgress}%</>
              ) : ytSyncState === 'done' ? (
                <><CheckCircle2 size={13} /> Timeline Unlocked!</>
              ) : (
                <><RefreshCw size={13} /> Unlock Timeline</>
              )}
            </button>
          )}
          <button
            onClick={handleShare}
            className="hidden sm:flex items-center gap-2 px-4 py-2 bg-zinc-900 border border-zinc-700 hover:border-blue-500/50 hover:bg-blue-500/10 hover:text-blue-400 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all text-zinc-300"
          >
            <Share2 size={14} />
            Share Link
          </button>
          <button
            onClick={handleApprove}
            className={cn(
              "flex items-center gap-2 px-6 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all border",
              project.isApproved
                ? "bg-green-600/20 border-green-500/40 text-green-400 hover:bg-green-600 hover:text-white hover:border-green-600"
                : "bg-zinc-900 border-zinc-700 text-zinc-200 hover:border-green-500/50 hover:bg-green-500/10 hover:text-green-400"
            )}
          >
            {project.isApproved ? <CheckCircle2 size={14} /> : <Check size={14} strokeWidth={4} />}
            {project.isApproved ? "Approved" : "Approve Video"}
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col lg:flex-row pt-16 overflow-hidden">
        {/* Video Player Section */}
        <div className="flex-[3] flex flex-col relative bg-black">
          <div className="relative flex-1 flex items-center justify-center bg-black overflow-hidden group">
            <div className="w-full aspect-video relative shadow-2xl z-10">
              {/* Unified video renderer: iframe for YouTube/Drive (if fallback), HTML5 for others */}
              {(isYouTubeEmbed || (isDriveEmbed && showIframeFallback)) ? (
                <iframe
                  key={project.videoUrl}
                  ref={iframeRef}
                  src={isDriveEmbed && showIframeFallback ? `https://drive.google.com/file/d/${extractDriveId(project.videoUrl)}/preview` : project.videoUrl}
                  className="w-full h-full relative z-0"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                  title="Video Player"
                  onLoad={() => {
                    if (isYouTubeEmbed) {
                      setTimeout(() => {
                        iframeRef.current?.contentWindow?.postMessage(
                          JSON.stringify({ event: 'listening', id: 1 }),
                          '*'
                        );
                      }, 500);
                    }
                  }}
                />
              ) : (
                <video
                  key={project.videoUrl}
                  ref={playerRef}
                  src={project.videoUrl}
                  className="w-full h-full relative z-0 bg-black"
                  controls={false}
                  playsInline
                  crossOrigin="anonymous"
                  onTimeUpdate={(e) => {
                    const video = e.currentTarget;
                    setCurrentTime(video.currentTime);
                  }}
                  onDurationChange={(e) => setDuration(e.currentTarget.duration)}
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onError={(e) => {
                    console.error("Video block detected:", e);
                    if (isDriveEmbed) {
                      setShowIframeFallback(true);
                      alert("Direct stream was blocked by Google. Switching to standard preview as it is.");
                    }
                  }}
                  onClick={() => {
                    if (playerRef.current) {
                      if (playerRef.current.paused) playerRef.current.play();
                      else playerRef.current.pause();
                    }
                  }}
                />
              )}

              {/* Playback indicator for custom video element */}
              {!isYouTubeEmbed && !playing && (
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none z-10"
                  onClick={() => playerRef.current?.play()}
                >
                  <div className="w-20 h-20 bg-black/40 backdrop-blur-md rounded-full flex items-center justify-center border border-white/20">
                    <Play size={40} className="text-white fill-white ml-2" />
                  </div>
                </div>
              )}

              <DrawingOverlay
                isActive={showDrawingMode}
                onSave={(d) => { setPendingDrawing(d); setShowDrawingMode(false); }}
                onCancel={() => setShowDrawingMode(false)}
              />

              {/* Drawing replay overlay (1s window, unless manual toggle) */}
              {(() => {
                const activeDrawings = project.comments.filter(c => {
                  if (!c.drawing?.paths?.length) return false;
                  // Visible ONLY within a 1s window of current playback time
                  const diff = currentTime - c.timestamp;
                  const isInWindow = diff >= 0 && diff <= 1.0;

                  // Visibility logic:
                  // 1. If manually hidden via the eye toggle, don't show.
                  // 2. If the comment is resolved, don't show by default (unless user toggled it TO BE VISIBLE).
                  // Wait, let's use hiddenDrawingIds simply. By default it's empty.
                  // If resolved, we implicitly treat it as hidden.
                  const isManuallyInState = hiddenDrawingIds.includes(c.id);
                  const isHidden = c.resolved ? !isManuallyInState : isManuallyInState;

                  return isInWindow && !isHidden;
                });

                if (activeDrawings.length === 0) return null;

                return (
                  <svg
                    className="absolute inset-0 w-full h-full pointer-events-none z-40"
                    viewBox="0 0 1000 1000"
                    preserveAspectRatio="none"
                  >
                    <AnimatePresence>
                      {activeDrawings.map(dc => (
                        <motion.g
                          key={dc.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.2 }}
                        >
                          {dc.drawing!.paths.map((path, i) => (
                            <polyline
                              key={i}
                              points={path.points.map(p => `${p.x * 1000},${p.y * 1000}`).join(' ')}
                              fill="none"
                              stroke={path.color || '#f97316'}
                              strokeWidth={path.width || 4}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              vectorEffect="non-scaling-stroke"
                            />
                          ))}
                        </motion.g>
                      ))}
                    </AnimatePresence>
                  </svg>
                );
              })()
              }

              {/* Fullscreen only — theater mode removed */}
              <div className="absolute top-6 right-6 z-40 flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <button
                  onClick={toggleFullScreen}
                  className="p-3 bg-black/60 backdrop-blur-md border border-white/10 rounded-xl text-white hover:bg-orange-500 hover:border-orange-400 transition-all"
                  title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                >
                  {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                </button>
              </div>
            </div>
          </div>

          {/* Player controls / Timeline */}
          <div className="bg-zinc-950 px-6 py-4 flex flex-col gap-3 border-t border-white/5">
            <div className="flex items-center gap-4">
              <button
                onClick={() => {
                  const next = !playing;
                  if (isYouTubeEmbed && iframeRef.current?.contentWindow) {
                    iframeRef.current.contentWindow.postMessage(
                      JSON.stringify({ event: 'command', func: next ? 'playVideo' : 'pauseVideo', args: [] }),
                      '*'
                    );
                  } else {
                    setPlaying(next);
                  }
                }}
                className="w-12 h-12 flex items-center justify-center bg-white rounded-full text-black hover:scale-110 transition-transform active:scale-95"
              >
                {playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1" />}
              </button>

              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center mb-1.5 px-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-orange-500 tracking-wider font-mono">
                      {formatTime(currentTime)}
                    </span>
                    <span className="text-[10px] text-zinc-600">/</span>
                    <span className="text-[10px] font-bold text-zinc-600 tracking-wider font-mono">
                      {formatTime(duration)}
                    </span>
                  </div>

                  {/* Zoom Controls */}
                  <div className="flex items-center gap-1 bg-zinc-900/50 rounded-lg p-0.5 border border-white/5">
                    {[1, 2, 5].map((z) => (
                      <button
                        key={z}
                        onClick={() => setTimelineZoom(z)}
                        className={cn(
                          "px-1.5 py-0.5 rounded text-[8px] font-black transition-all",
                          timelineZoom === z
                            ? "bg-orange-500 text-white"
                            : "text-zinc-500 hover:text-zinc-300"
                        )}
                      >
                        {z}x
                      </button>
                    ))}
                    <ZoomIn size={10} className="ml-1 mr-0.5 text-zinc-600" />
                  </div>
                </div>

                <div
                  className="relative h-6 flex items-center overflow-x-auto overflow-y-hidden custom-scrollbar touch-pan-x"
                >
                  <div
                    ref={timelineContainerRef}
                    className="relative h-2 bg-zinc-900 rounded-full cursor-pointer flex-shrink-0"
                    style={{ width: `${timelineZoom * 100}%` }}
                    onMouseDown={handleTimelineInteraction}
                    onTouchStart={handleTimelineInteraction}
                    onTouchMove={handleTimelineInteraction}
                  >
                    <motion.div
                      className="absolute left-0 top-0 h-full bg-gradient-to-r from-orange-600 to-orange-400 rounded-full z-10"
                      style={{ width: `${(currentTime / duration) * 100}%` }}
                    />
                    {/* Vertical Playhead Line */}
                    <motion.div
                      className="absolute top-[-8px] bottom-[-8px] w-1 bg-white shadow-[0_0_10px_rgba(255,255,255,0.5)] z-30 rounded-full"
                      style={{ left: `${(currentTime / duration) * 100}%` }}
                    />
                    {filteredComments.map(c => {
                      const dotColor = c.resolved
                        ? 'bg-zinc-600'
                        : c.type === 'audio'
                          ? 'bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.6)]'
                          : c.type === 'drawing'
                            ? 'bg-purple-500 shadow-[0_0_6px_rgba(168,85,247,0.6)]'
                            : 'bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.5)]';
                      const tooltipText = c.type === 'text'
                        ? (c.text?.slice(0, 40) ?? '') + (c.text && c.text.length > 40 ? '…' : '')
                        : c.type === 'audio' ? '🎙 Voice comment'
                          : '✏️ Drawing markup';
                      return (
                        <div
                          key={c.id}
                          className="absolute top-1/2 -translate-y-1/2 z-20 cursor-pointer"
                          style={{ left: `${(c.timestamp / duration) * 100}%` }}
                          onClick={(e) => { e.stopPropagation(); seekToComment(c); }}
                          onMouseEnter={() => setHoveredComment(c.id)}
                          onMouseLeave={() => setHoveredComment(null)}
                        >
                          <div className={cn(
                            "w-2.5 h-2.5 rounded-full border border-black transition-all hover:scale-150",
                            dotColor
                          )} />
                          {hoveredComment === c.id && (
                            <div
                              className="absolute bottom-5 left-1/2 -translate-x-1/2 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 shadow-2xl z-50 min-w-[140px] max-w-[220px]"
                              onMouseEnter={() => setHoveredComment(c.id)}
                              onMouseLeave={() => setHoveredComment(null)}
                            >
                              <p className={cn(
                                "text-[10px] font-bold uppercase tracking-widest mb-1",
                                c.type === 'audio' ? 'text-blue-400' : c.type === 'drawing' ? 'text-purple-400' : 'text-orange-400'
                              )}>
                                {c.type} · {formatTime(c.timestamp)}
                              </p>
                              <p className="text-[11px] text-zinc-300 font-medium leading-snug mb-2">{tooltipText}</p>
                              {c.type === 'audio' && c.audioUrl && (
                                <audio src={c.audioUrl} controls className="w-full h-10 opacity-80" preload="metadata" />
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); scrollToComment(c.id); }}
                                className="mt-1.5 text-[9px] font-black uppercase tracking-widest text-zinc-500 hover:text-white transition-colors"
                              >
                                Jump to comment ↓
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="flex gap-2">
                <button className="p-2.5 text-zinc-500 hover:text-white transition-colors">
                  <Volume2 size={20} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar Section: Locked Layout */}
        <aside className="w-full lg:w-[400px] h-full flex flex-col bg-[#050505] border-l border-white/5 order-2 lg:order-2 overflow-hidden shadow-2xl z-30">
          {/* Mobile: compact filter strip at top */}
          <div className="p-4 lg:p-6 border-b border-white/5 flex-shrink-0">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-black italic uppercase tracking-[0.2em] text-zinc-400">Comments</h3>
              <div className="flex bg-zinc-950 p-1 rounded-lg border border-white/5">
                {(['all', 'unresolved', 'resolved'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={cn(
                      "px-2.5 py-1.5 rounded-md text-[9px] font-black uppercase tracking-widest transition-all",
                      filter === f ? "bg-zinc-800 text-white" : "text-zinc-600 hover:text-zinc-400"
                    )}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {/* Desktop: restore separate buttons for initial comment */}
            <div className="hidden lg:block">
              {!isComposing ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => { setIsComposing(true); setActiveComposerTab('text'); }}
                    className="flex-1 bg-orange-500/10 hover:bg-orange-500 border border-orange-500/20 p-3 rounded-xl flex items-center justify-center gap-2 group transition-all"
                  >
                    <MessageSquare size={16} className="text-orange-500 group-hover:text-white transition-colors" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400 group-hover:text-white">Text</span>
                  </button>
                  <button
                    onClick={() => { setIsComposing(true); setActiveComposerTab('audio'); setShowAudioMode(true); }}
                    className="flex-1 bg-blue-500/10 hover:bg-blue-600 border border-blue-500/20 p-3 rounded-xl flex items-center justify-center gap-2 group transition-all"
                  >
                    <Mic size={16} className="text-blue-500 group-hover:text-white transition-colors" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400 group-hover:text-white">Voice</span>
                  </button>
                  <button
                    onClick={() => { setPlaying(false); setIsComposing(true); setActiveComposerTab('drawing'); setShowDrawingMode(true); }}
                    className="flex-1 bg-purple-500/10 hover:bg-purple-600 border border-purple-500/20 p-3 rounded-xl flex items-center justify-center gap-2 group transition-all"
                  >
                    <Pencil size={16} className="text-purple-500 group-hover:text-white transition-colors" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400 group-hover:text-white">Draw</span>
                  </button>
                </div>
              ) : (
                <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-black uppercase tracking-widest text-orange-500 mr-2">@ {formatTime(currentTime)}</span>
                      {/* Tabs for switching / combining content */}
                      <div className="flex items-center gap-1.5 p-1 bg-black/40 rounded-lg border border-white/5">
                        <button
                          onClick={() => setActiveComposerTab('text')}
                          className={cn("p-1.5 rounded-md transition-all", activeComposerTab === 'text' ? "bg-orange-500 text-white" : "text-zinc-600 hover:text-zinc-400")}
                        >
                          <MessageSquare size={12} />
                        </button>
                        <button
                          onClick={() => { setActiveComposerTab('audio'); if (!pendingAudio) setShowAudioMode(true); }}
                          className={cn("p-1.5 rounded-md transition-all relative", activeComposerTab === 'audio' ? "bg-blue-500 text-white" : "text-zinc-600 hover:text-zinc-400")}
                        >
                          <Mic size={12} />
                          {pendingAudio && <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-green-500 rounded-full" />}
                        </button>
                        <button
                          onClick={() => { setActiveComposerTab('drawing'); if (!pendingDrawing) setShowDrawingMode(true); }}
                          className={cn("p-1.5 rounded-md transition-all relative", activeComposerTab === 'drawing' ? "bg-purple-500 text-white" : "text-zinc-600 hover:text-zinc-400")}
                        >
                          <Pencil size={12} />
                          {pendingDrawing && <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-green-500 rounded-full" />}
                        </button>
                      </div>
                    </div>
                    <button onClick={() => { setIsComposing(false); setPendingDrawing(null); setPendingAudio(null); setComposerText(''); setShowDrawingMode(false); setShowAudioMode(false); }} className="text-zinc-600 hover:text-white">
                      <X size={14} />
                    </button>
                  </div>

                  {activeComposerTab === 'text' && (
                    <textarea
                      autoFocus
                      value={composerText}
                      onChange={e => setComposerText(e.target.value)}
                      placeholder="Type feedback..."
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm focus:outline-none focus:border-orange-500/50 transition-all min-h-[60px] resize-none text-zinc-200 placeholder:text-zinc-600"
                    />
                  )}

                  {activeComposerTab === 'audio' && (
                    <div className="py-1">
                      {pendingAudio ? (
                        <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
                          <div className="w-2 h-2 rounded-full bg-blue-400" />
                          <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider flex-1">Voice Recorded</span>
                          <button onClick={() => { setPendingAudio(null); setShowAudioMode(true); }} className="text-zinc-600 hover:text-red-400 transition-colors text-[9px] font-black uppercase tracking-widest px-2 py-1 bg-zinc-900 rounded">Retake</button>
                        </div>
                      ) : (
                        <AudioRecorder
                          onSave={(url) => { setPendingAudio(url); }}
                          onCancel={() => { setShowAudioMode(false); setActiveComposerTab('text'); }}
                        />
                      )}
                    </div>
                  )}

                  {activeComposerTab === 'drawing' && (
                    <div className="py-2 text-center border border-dashed border-zinc-800 rounded-lg">
                      {pendingDrawing ? (
                        <div className="flex flex-col items-center gap-2 py-1">
                          <span className="text-[10px] font-bold text-purple-400 uppercase tracking-wider">Drawing Staged</span>
                          <button onClick={() => { setPendingDrawing(null); setShowDrawingMode(true); }} className="text-[9px] font-black uppercase tracking-widest px-3 py-1 bg-zinc-800 text-zinc-400 rounded hover:text-white transition-colors">Redraw</button>
                        </div>
                      ) : (
                        <p className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest animate-pulse">Drawing on video player...</p>
                      )}
                    </div>
                  )}

                  {/* Unified Post Button */}
                  <button
                    onClick={() => {
                      if (!composerText.trim() && !pendingAudio && !pendingDrawing) return;
                      onAddComment({
                        timestamp: currentTime,
                        text: composerText.trim() || undefined,
                        audioUrl: pendingAudio || undefined,
                        drawing: pendingDrawing || undefined,
                      });
                      setComposerText('');
                      setPendingAudio(null);
                      setPendingDrawing(null);
                      setIsComposing(false);
                      setShowDrawingMode(false);
                      setShowAudioMode(false);
                    }}
                    disabled={!composerText.trim() && !pendingAudio && !pendingDrawing}
                    className="w-full bg-orange-500 disabled:opacity-30 text-white py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all hover:bg-orange-600 flex items-center justify-center gap-2 shadow-lg shadow-orange-500/20"
                  >
                    <Send size={13} />
                    Post Combined
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Comments list - scrollable field */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar p-4 lg:p-6 space-y-4 pb-32 lg:pb-6">
            {filteredComments.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center py-12 text-center opacity-30">
                <div className="w-16 h-16 bg-zinc-900 rounded-full flex items-center justify-center mb-4">
                  <MessageSquare size={32} />
                </div>
                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-zinc-500">No expressions yet</p>
              </div>
            ) : (
              filteredComments.map(comment => (
                <motion.div
                  layout
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  key={comment.id}
                  ref={(el) => { commentRefs.current[comment.id] = el; }}
                  className={cn(
                    "group relative border p-4 rounded-xl transition-all cursor-pointer",
                    highlightedComment === comment.id
                      ? "bg-orange-500/10 border-orange-500/40 shadow-lg shadow-orange-500/10"
                      : comment.resolved
                        ? "bg-zinc-900/20 border-zinc-800/30 opacity-50 grayscale"
                        : "bg-zinc-900/40 border-zinc-800/50 hover:bg-zinc-900/60"
                  )}
                  onClick={() => seekToComment(comment)}
                >
                  <div className="flex items-center justify-between mb-3">
                    <button
                      onClick={() => handleSeek(comment.timestamp)}
                      className={cn(
                        "text-[10px] font-black italic px-2 py-0.5 rounded-md transition-all flex items-center gap-1",
                        comment.type === 'audio'
                          ? 'text-blue-400 bg-blue-500/10 hover:bg-blue-500 hover:text-white'
                          : comment.type === 'drawing'
                            ? 'text-purple-400 bg-purple-500/10 hover:bg-purple-500 hover:text-white'
                            : 'text-orange-400 bg-orange-500/10 hover:bg-orange-500 hover:text-white'
                      )}
                    >
                      {comment.type === 'audio' ? <Mic size={10} /> : comment.type === 'drawing' ? <Pencil size={10} /> : <MessageSquare size={10} />}
                      {formatTime(comment.timestamp)}
                    </button>
                    <button
                      onClick={() => onToggleCommentResolution(comment.id)}
                      className={cn(
                        "p-1.5 rounded-lg transition-all",
                        comment.resolved ? "text-green-500 bg-green-500/10" : "text-zinc-600 hover:text-red-500 hover:bg-red-500/10"
                      )}
                    >
                      {comment.resolved ? <CheckCircle2 size={16} /> : <div className="w-4 h-4 rounded-full border-2 border-current" />}
                    </button>
                  </div>

                  {/* Unified Content Rendering */}
                  {(comment.text || comment.audioUrl || comment.drawing) ? (
                    <div className="space-y-3">
                      {comment.text && (
                        <p className="text-sm font-medium text-zinc-200 leading-relaxed break-words whitespace-pre-wrap">{comment.text}</p>
                      )}

                      {comment.audioUrl && (
                        <audio src={comment.audioUrl} controls className="w-full h-10 opacity-60 invert" preload="metadata" />
                      )}

                      {comment.drawing?.paths?.length > 0 && (
                        <div className="flex items-center justify-between pt-1">
                          <div className="flex items-center gap-2 text-zinc-500 text-[9px] font-black uppercase tracking-widest">
                            <Pencil size={10} />
                            Visual Markup
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setHiddenDrawingIds(prev =>
                                prev.includes(comment.id)
                                  ? prev.filter(id => id !== comment.id)
                                  : [...prev, comment.id]
                              );
                            }}
                            className={cn(
                              "p-2 rounded-full transition-all",
                              (comment.resolved ? hiddenDrawingIds.includes(comment.id) : !hiddenDrawingIds.includes(comment.id))
                                ? 'text-orange-500 bg-orange-500/10 border border-orange-500/20'
                                : 'text-zinc-600 bg-zinc-900/50 hover:text-orange-400 hover:bg-orange-500/10'
                            )}
                            title="Toggle visibility during window"
                          >
                            {(comment.resolved ? hiddenDrawingIds.includes(comment.id) : !hiddenDrawingIds.includes(comment.id))
                              ? <Eye size={16} />
                              : <EyeOff size={16} />}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs italic text-zinc-600">No content</p>
                  )}

                  <div className="mt-3 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[8px] font-bold text-zinc-600 uppercase tracking-widest">
                      {new Date(comment.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </motion.div>
              ))
            )}
          </div>
        </aside>
      </div>

      {/* Orientation-aware Floating Mobile Action Bar — visible in full screen */}
      <div className={cn(
        "lg:hidden fixed z-[100] transition-all duration-300",
        // Desktop landscape or mobile landscape
        "landscape:right-6 landscape:bottom-auto landscape:top-1/2 landscape:-translate-y-1/2",
        // Mobile portrait
        "portrait:bottom-8 portrait:left-1/2 portrait:-translate-x-1/2 portrait:w-[90%]"
      )}>
        {!isComposing ? (
          <div className="flex landscape:flex-col gap-3 p-3 bg-zinc-950/80 backdrop-blur-2xl border border-white/10 rounded-[2rem] shadow-2xl">
            <button
              onClick={() => { setIsComposing(true); setActiveComposerTab('text'); }}
              className="flex-1 h-14 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex flex-col items-center justify-center gap-1 active:scale-90 transition-all shadow-lg"
            >
              <MessageSquare size={16} className="text-orange-400" />
              <span className="text-[8px] font-black uppercase tracking-widest text-zinc-400">Text</span>
            </button>
            <button
              onClick={() => { setIsComposing(true); setActiveComposerTab('audio'); setShowAudioMode(true); }}
              className="flex-1 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex flex-col items-center justify-center gap-1 active:scale-90 transition-all shadow-lg"
            >
              <Mic size={16} className="text-blue-400" />
              <span className="text-[8px] font-black uppercase tracking-widest text-zinc-400">Voice</span>
            </button>
            <button
              onClick={() => { setPlaying(false); setIsComposing(true); setActiveComposerTab('drawing'); setShowDrawingMode(true); }}
              className="flex-1 h-14 rounded-2xl bg-purple-500/10 border border-purple-500/20 flex flex-col items-center justify-center gap-1 active:scale-90 transition-all shadow-lg"
            >
              <Pencil size={16} className="text-purple-400" />
              <span className="text-[8px] font-black uppercase tracking-widest text-zinc-400">Draw</span>
            </button>
          </div>
        ) : (
          <div className="bg-zinc-900/95 backdrop-blur-2xl border border-zinc-800 rounded-[2rem] p-5 shadow-2xl w-full max-w-[calc(100vw-3rem)] max-h-[80vh] overflow-y-auto relative">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500 bg-black/40 px-2 py-1 rounded">@ {formatTime(currentTime)}</span>
                <div className="flex items-center gap-1 p-1 bg-black/40 rounded-full border border-white/5">
                  <button onClick={() => setActiveComposerTab('text')} className={cn("p-2 rounded-full transition-all", activeComposerTab === 'text' ? "bg-orange-500 text-white" : "text-zinc-600")}><MessageSquare size={14} /></button>
                  <button onClick={() => { setActiveComposerTab('audio'); if (!pendingAudio) setShowAudioMode(true); }} className={cn("p-2 rounded-full transition-all relative", activeComposerTab === 'audio' ? "bg-blue-500 text-white" : "text-zinc-600")}><Mic size={14} />{pendingAudio && <div className="absolute top-0 right-0 w-2 h-2 bg-green-500 rounded-full border border-zinc-900" />}</button>
                  <button onClick={() => { setActiveComposerTab('drawing'); if (!pendingDrawing) setShowDrawingMode(true); }} className={cn("p-2 rounded-full transition-all relative", activeComposerTab === 'drawing' ? "bg-purple-500 text-white" : "text-zinc-600")}><Pencil size={14} />{pendingDrawing && <div className="absolute top-0 right-0 w-2 h-2 bg-green-500 rounded-full border border-zinc-900" />}</button>
                </div>
              </div>
              <button onClick={() => { setIsComposing(false); setComposerText(''); setPendingAudio(null); setPendingDrawing(null); setShowDrawingMode(false); setShowAudioMode(false); }} className="text-zinc-500 hover:text-white p-2">
                <X size={20} />
              </button>
            </div>

            {activeComposerTab === 'text' && (
              <textarea
                autoFocus
                value={composerText}
                onChange={e => setComposerText(e.target.value)}
                placeholder="Share your thoughts..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-4 text-sm focus:outline-none focus:border-orange-500 transition-all min-h-[120px] mb-4 text-white placeholder:text-zinc-700"
              />
            )}

            {activeComposerTab === 'audio' && (
              <div className="py-4">
                {pendingAudio ? (
                  <div className="flex items-center gap-3 bg-blue-500/10 border border-blue-500/20 rounded-2xl px-5 py-4">
                    <div className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-pulse" />
                    <span className="text-sm font-black uppercase text-blue-400 flex-1">Voice Ready</span>
                    <button onClick={() => { setPendingAudio(null); setShowAudioMode(true); }} className="text-[10px] font-black uppercase tracking-widest px-4 py-2 bg-zinc-800 text-zinc-300 rounded-xl hover:bg-zinc-700 transition-all">Retake</button>
                  </div>
                ) : (
                  <AudioRecorder onSave={(url) => { setPendingAudio(url); }} onCancel={() => { setShowAudioMode(false); setActiveComposerTab('text'); }} />
                )}
              </div>
            )}

            {activeComposerTab === 'drawing' && (
              <div className="py-8 text-center border-2 border-dashed border-zinc-800 rounded-2xl bg-zinc-950/30">
                {pendingDrawing ? (
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 bg-purple-500/20 rounded-full flex items-center justify-center border border-purple-500/30">
                      <Pencil size={24} className="text-purple-400" />
                    </div>
                    <span className="text-xs font-black uppercase tracking-widest text-purple-400">Sketch Captured</span>
                    <button onClick={() => { setPendingDrawing(null); setShowDrawingMode(true); }} className="text-[10px] font-black uppercase tracking-widest px-6 py-3 bg-zinc-800 text-zinc-300 rounded-xl">Redraw</button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <Pencil size={32} className="text-zinc-700" />
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500 animate-pulse">Sketch directly on the video</p>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={() => {
                if (!composerText.trim() && !pendingAudio && !pendingDrawing) return;
                onAddComment({
                  timestamp: currentTime,
                  text: composerText.trim() || undefined,
                  audioUrl: pendingAudio || undefined,
                  drawing: pendingDrawing || undefined,
                });
                setComposerText('');
                setPendingAudio(null);
                setPendingDrawing(null);
                setIsComposing(false);
              }}
              className="w-full bg-gradient-to-r from-orange-500 to-amber-500 text-white py-4 rounded-2xl font-black italic uppercase tracking-widest shadow-2xl shadow-orange-500/30 active:scale-[0.98] transition-all"
            >
              Post Reflection
            </button>
          </div>
        )}
      </div>

      {/* Success Modal */}
      <AnimatePresence>
        {showApprovedState && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-md"
          >
            <div className="bg-zinc-900 border border-green-500/30 p-10 rounded-2xl text-center shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-green-500" />
              <div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <CheckCircle2 size={32} className="text-green-500" />
              </div>
              <h2 className="text-2xl font-black italic uppercase tracking-tighter mb-2 text-white">Video Approved!</h2>
              <p className="text-zinc-500 text-[10px] font-bold uppercase tracking-widest leading-loose">The editor has been notified.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
