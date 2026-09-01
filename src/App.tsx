/**
 * ReviseAI - Interactive Study & Revision Platform
 * Analyzes links and uploaded files to teach step-by-step, generate interactive notes & flashcards, and create adaptive practice questions.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Header } from './components/Header';
import { SourceManager } from './components/SourceManager';
import { LessonTutorView } from './components/LessonTutorView';
import { InteractiveNotesView } from './components/InteractiveNotesView';
import { QuizPracticeView } from './components/QuizPracticeView';
import { MyTopicsView } from './components/MyTopicsView';
import { ProgressModal } from './components/ProgressModal';
import {
  SourceDocument,
  RevisionLesson,
  StudyNotesData,
  QuizSet,
  ChatMessage,
  RevisionProject,
  LessonSection
} from './types';
import { generateLesson, generateNotes, generateQuiz, generateProjectTitle } from './services/api';
import { calculateTopicMastery, getDefaultTopicProgress, getLocalDateKey } from './utils/progress';
import { Sparkles, AlertCircle } from 'lucide-react';
import { onAuthStateChanged, User, auth, db } from './lib/firebase';
import { LoginView } from './components/LoginView';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const STORAGE_KEY_LIBRARY = 'revise_ai_study_library_v3';
const STORAGE_KEY_LEGACY = 'revise_ai_study_workspace_v2';
const STORAGE_KEY_GUEST = 'revise_ai_guest_mode';

function sanitizeForFirestore(obj: any): any {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeForFirestore(item));
  }
  const cleanObj: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) {
      cleanObj[key] = sanitizeForFirestore(val);
    }
  }
  return cleanObj;
}

function createNewProject(initialTitle = ''): RevisionProject {
  return {
    id: `project-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    title: initialTitle,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sources: [],
    language: 'English',
    teachingStyle: 'standard',
    customInstruction: '',
    allowWebSearch: true, // Auto-ticked by default especially when no sources
    chatHistory: [],
  };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'topics' | 'sources' | 'teach' | 'notes' | 'quiz'>('topics');
  const [projects, setProjects] = useState<RevisionProject[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_LIBRARY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  });
  const [currentProjectId, setCurrentProjectId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_LIBRARY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[0].id;
      }
    } catch {}
    return '';
  });
  const [isProgressModalOpen, setIsProgressModalOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isGuest, setIsGuest] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_GUEST) === 'true';
    } catch {
      return false;
    }
  });

  // Generation loading state
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [globalError, setGlobalError] = useState<string | null>(null);

  const blankProject = useMemo(() => createNewProject(), []);

  // Current active project accessor
  const currentProject = projects.find((p) => p.id === currentProjectId) || projects[0] || blankProject;
  const currentMastery = calculateTopicMastery(currentProject);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        // Guest mode: load guest/local topics if available
        try {
          const localSaved = localStorage.getItem(STORAGE_KEY_LIBRARY);
          if (localSaved) {
            const parsed = JSON.parse(localSaved);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setProjects(parsed);
              setCurrentProjectId((prev) => (prev && parsed.some((p: any) => p.id === prev) ? prev : parsed[0].id));
            }
          }
        } catch (e) {
          console.warn('Error reading guest storage:', e);
        }
        setIsAuthLoading(false);
        return;
      }

      // User has logged in: Fetch their saved cloud topics from Firestore and merge with any active in-memory/guest topics
      try {
        setIsGuest(false);
        try {
          localStorage.removeItem(STORAGE_KEY_GUEST);
        } catch {}

        const userRef = doc(db, 'users', currentUser.uid);
        const docSnap = await getDoc(userRef);
        
        let cloudProjects: RevisionProject[] = [];
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.projects && Array.isArray(data.projects)) {
            cloudProjects = data.projects;
          }
        } else {
          // Check user-specific localStorage cache if Firestore doc not yet created
          try {
            const cached = localStorage.getItem(`revise_ai_user_${currentUser.uid}_projects`);
            if (cached) {
              const parsed = JSON.parse(cached);
              if (Array.isArray(parsed)) cloudProjects = parsed;
            }
          } catch {}
        }

        // Merge local in-memory / guest projects into cloud topics so user never loses their active work
        const projectMap = new Map<string, RevisionProject>();
        for (const cp of cloudProjects) {
          if (cp && cp.id) projectMap.set(cp.id, cp);
        }

        // Check currently loaded projects in state or guest storage
        const localCandidates: RevisionProject[] = [...projects];
        try {
          const guestSaved = localStorage.getItem(STORAGE_KEY_LIBRARY);
          if (guestSaved) {
            const parsed = JSON.parse(guestSaved);
            if (Array.isArray(parsed)) {
              for (const p of parsed) {
                if (p && p.id && !localCandidates.some((c) => c.id === p.id)) {
                  localCandidates.push(p);
                }
              }
            }
          }
        } catch {}

        for (const lp of localCandidates) {
          if (lp && lp.id && (lp.title || lp.sources?.length || lp.lesson || lp.notes || lp.quiz)) {
            const existing = projectMap.get(lp.id);
            if (!existing || ((lp.updatedAt || 0) >= (existing.updatedAt || 0))) {
              projectMap.set(lp.id, lp);
            }
          }
        }

        const mergedProjects = Array.from(projectMap.values());

        // Update state
        setProjects(mergedProjects);

        // Retain or select active project
        if (mergedProjects.length > 0) {
          setCurrentProjectId((prev) => (prev && mergedProjects.some((p) => p.id === prev) ? prev : mergedProjects[0].id));
        } else {
          setCurrentProjectId('');
        }

        // Persist merged data immediately to Firestore and localStorage
        const cleanPayload = sanitizeForFirestore({
          projects: mergedProjects,
          updatedAt: Date.now(),
          email: currentUser.email || '',
          displayName: currentUser.displayName || '',
        });

        await setDoc(userRef, cleanPayload, { merge: true }).catch((e) => {
          console.warn('Initial Firestore save warning:', e);
        });

        try {
          localStorage.setItem(`revise_ai_user_${currentUser.uid}_projects`, JSON.stringify(mergedProjects));
          // Clear guest storage after successful migration into user account
          localStorage.removeItem(STORAGE_KEY_LIBRARY);
        } catch {}

      } catch (err) {
        console.warn("Could not retrieve topics from Firestore, using local cache:", err);
        try {
          const cached = localStorage.getItem(`revise_ai_user_${currentUser.uid}_projects`);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed)) {
              setProjects(parsed);
              if (parsed.length > 0) setCurrentProjectId(parsed[0].id);
            }
          }
        } catch {}
      } finally {
        setIsAuthLoading(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // Persist projects whenever projects change:
  // - To Firestore & User Cache for logged in users
  // - To LocalStorage for guest users
  useEffect(() => {
    if (isAuthLoading) return;

    if (user) {
      try {
        const cleanPayload = sanitizeForFirestore({
          projects,
          updatedAt: Date.now(),
          email: user.email || '',
          displayName: user.displayName || '',
        });
        const userRef = doc(db, 'users', user.uid);
        setDoc(userRef, cleanPayload, { merge: true }).catch((e) => {
          console.warn("Failed to sync to Firestore in background", e);
        });
        localStorage.setItem(`revise_ai_user_${user.uid}_projects`, JSON.stringify(projects));
      } catch (e) {
        console.warn("Failed to initiate Firestore sync", e);
      }
    } else {
      try {
        localStorage.setItem(STORAGE_KEY_LIBRARY, JSON.stringify(projects));
      } catch (e) {
        console.warn("Failed to save to local guest storage", e);
      }
    }
  }, [projects, user, isAuthLoading]);

  // Auto-scroll to top when tab or project changes
  useEffect(() => {
    const scrollToTop = () => {
      window.scrollTo(0, 0);
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
    };
    
    scrollToTop();
    // Use multiple timeouts to guarantee scroll after React renders
    setTimeout(scrollToTop, 10);
    setTimeout(scrollToTop, 50);
    setTimeout(scrollToTop, 100);
  }, [activeTab, currentProjectId]);

  // Helper to update current project immutably
  const updateCurrentProject = (updater: (prev: RevisionProject) => RevisionProject) => {
    setProjects((prev) => {
      const exists = prev.some((p) => p.id === currentProject.id);
      if (exists) {
        return prev.map((p) => {
          if (p.id === currentProject.id) {
            const updated = updater(p);
            return { ...updated, updatedAt: Date.now() };
          }
          return p;
        });
      } else {
        const updated = updater(currentProject);
        if (!currentProjectId) {
          setCurrentProjectId(updated.id);
        }
        return [{ ...updated, updatedAt: Date.now() }, ...prev];
      }
    });
  };

  // State setters for active project
  const setTopicTitle = (title: string) => {
    updateCurrentProject((p) => ({ ...p, title }));
  };

  const setLanguage = (language: string) => {
    updateCurrentProject((p) => ({ ...p, language }));
  };

  const setTeachingStyle = (teachingStyle: string) => {
    updateCurrentProject((p) => ({ ...p, teachingStyle }));
  };

  const setCustomInstruction = (customInstruction: string) => {
    updateCurrentProject((p) => ({ ...p, customInstruction }));
  };

  const setAllowWebSearch = (allowWebSearch: boolean) => {
    updateCurrentProject((p) => ({ ...p, allowWebSearch }));
  };

  const handleAddSource = (newSource: SourceDocument) => {
    updateCurrentProject((p) => ({
      ...p,
      sources: [...p.sources, newSource],
      title: p.title || newSource.title || 'Revision Topic',
    }));
  };

  const handleRemoveSource = (id: string) => {
    updateCurrentProject((p) => ({
      ...p,
      sources: p.sources.filter((s) => s.id !== id),
    }));
  };

  const handleClearSources = () => {
    updateCurrentProject((p) => ({
      ...p,
      sources: [],
    }));
  };

  const handleUpdateSection = (sectionIndex: number, updatedSection: LessonSection) => {
    updateCurrentProject((p) => {
      if (!p.lesson) return p;
      const updatedSections = [...p.lesson.sections];
      updatedSections[sectionIndex] = updatedSection;
      return {
        ...p,
        lesson: {
          ...p.lesson,
          sections: updatedSections,
        },
      };
    });
  };

  // Project Library actions
  const handleCreateNewTopic = () => {
    const newProj = createNewProject();
    setProjects((prev) => [newProj, ...prev]);
    setCurrentProjectId(newProj.id);
    setActiveTab('sources');
  };

  const handleOpenProject = (project: RevisionProject) => {
    setCurrentProjectId(project.id);
    if (project.lesson) {
      setActiveTab('teach');
    } else {
      setActiveTab('sources');
    }
  };

  const handleDeleteProject = (id: string) => {
    setProjects((prev) => {
      const remaining = prev.filter((p) => p.id !== id);
      if (remaining.length === 0) {
        setCurrentProjectId('');
        return [];
      }
      if (currentProjectId === id) {
        setCurrentProjectId(remaining[0].id);
      }
      return remaining;
    });
  };

  const handleDuplicateProject = (project: RevisionProject) => {
    const duplicated: RevisionProject = {
      ...project,
      id: `project-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      title: `${project.title} (Copy)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setProjects((prev) => [duplicated, ...prev]);
    setCurrentProjectId(duplicated.id);
  };

  // Regenerate Notes with selected focus / angle
  const [isRegeneratingNotes, setIsRegeneratingNotes] = useState(false);

  const handleRegenerateNotes = async (focus: 'standard' | 'analogies' | 'concise' | 'exam' | 'tables') => {
    setIsRegeneratingNotes(true);
    try {
      const activeSources = currentProject.sources || [];
      const updatedNotes = await generateNotes(
        currentProject.title,
        activeSources,
        currentProject.customInstruction,
        currentProject.teachingStyle,
        currentProject.language,
        currentProject.allowWebSearch,
        currentProject.lesson,
        focus
      );
      updateCurrentProject((p) => ({
        ...p,
        notes: updatedNotes,
      }));
    } catch (err: any) {
      console.error('Failed to regenerate notes:', err);
      setGlobalError(err.message || 'Failed to refresh notes');
    } finally {
      setIsRegeneratingNotes(false);
    }
  };

  // Generate All Revision Modules (Lesson, Notes, Quiz) concurrently in parallel with Title Polishing
  const handleGenerateAll = async () => {
    const activeSources = currentProject.sources || [];
    
    let draftTitle = currentProject.title.trim();
    if (!draftTitle && activeSources.length === 0) {
      setGlobalError('Please provide a topic title or at least one source.');
      return;
    }

    setIsLoading(true);
    setGlobalError(null);
    setLoadingStep('Synthesizing in-depth study notes, active recall flashcards & interactive lesson...');

    try {
      const combinedText = activeSources.map(s => `${s.title}: ${s.content || ''}`).join('\n').substring(0, 3000);
      const effectiveTopicTitle = draftTitle || (activeSources[0]?.title || 'Revision Topic');

      // 1. Title polishing runs fast in parallel without blocking note/lesson generation
      const titlePromise = generateProjectTitle(combinedText, draftTitle, activeSources)
        .then((refinedTitle) => {
          if (refinedTitle && refinedTitle.trim() && refinedTitle !== 'New Revision Topic') {
            setTopicTitle(refinedTitle.trim());
            return refinedTitle.trim();
          }
          return effectiveTopicTitle;
        })
        .catch(() => effectiveTopicTitle);

      // 2. Interactive Step-by-Step Lesson
      const lessonPromise = generateLesson(
        effectiveTopicTitle,
        activeSources,
        currentProject.customInstruction,
        currentProject.teachingStyle,
        currentProject.language,
        currentProject.allowWebSearch
      );

      // 3. In-Depth Study Notes, 3D Flashcards & Concept Map (given primary depth & parallel execution)
      const notesPromise = generateNotes(
        effectiveTopicTitle,
        activeSources,
        currentProject.customInstruction,
        currentProject.teachingStyle,
        currentProject.language,
        currentProject.allowWebSearch
      );

      // 4. Practice Questions & Exam Marking Rubrics
      const quizPromise = generateQuiz(
        effectiveTopicTitle,
        activeSources,
        8,
        'medium',
        currentProject.customInstruction,
        currentProject.teachingStyle,
        currentProject.language,
        undefined, // questionTypes
        currentProject.allowWebSearch
      );

      // Await all revision materials simultaneously
      const [finalTitle, generatedLesson, generatedNotes, generatedQuiz] = await Promise.all([
        titlePromise,
        lessonPromise,
        notesPromise,
        quizPromise,
      ]);

      // Update active project with all generated revision assets
      updateCurrentProject((p) => ({
        ...p,
        title: finalTitle || p.title,
        lesson: generatedLesson,
        notes: generatedNotes,
        quiz: generatedQuiz,
        chatHistory: [],
      }));

      // Transition to Teaching view once completed
      setActiveTab('teach');
    } catch (err: any) {
      console.error('Error generating revision materials:', err);
      setGlobalError(
        err.message || 'Failed to generate study materials. Please check your source material and try again.'
      );
    } finally {
      setIsLoading(false);
      setLoadingStep('');
    }
  };

  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (!user && !isGuest) {
    return (
      <LoginView
        onContinueAsGuest={() => {
          setIsGuest(true);
          try {
            localStorage.setItem(STORAGE_KEY_GUEST, 'true');
          } catch {}
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      {/* Top Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        topicTitle={currentProject.title}
        setTopicTitle={setTopicTitle}
        sourceCount={currentProject.sources.length}
        savedTopicsCount={projects.length}
        hasLesson={!!currentProject.lesson}
        hasNotes={!!currentProject.notes}
        hasQuiz={!!currentProject.quiz}
        masteryScore={currentMastery.overallMasteryScore}
        masteryTier={currentMastery.masteryTier}
        onOpenProgressModal={() => setIsProgressModalOpen(true)}
        onNewTopic={handleCreateNewTopic}
        user={user}
      />

      <ProgressModal
        project={currentProject}
        allProjects={projects}
        isOpen={isProgressModalOpen}
        onClose={() => setIsProgressModalOpen(false)}
        onNavigateTab={(tab) => {
          setActiveTab(tab);
          setIsProgressModalOpen(false);
        }}
        onResetProgress={() => {
          updateCurrentProject((p) => ({
            ...p,
            progress: undefined,
          }));
          setIsProgressModalOpen(false);
        }}
      />

      {/* Global Error Banner */}
      {globalError && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-4">
          <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs sm:text-sm flex items-center justify-between gap-3 shadow-xs">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0" />
              <span>{globalError}</span>
            </div>
            <button
              onClick={() => setGlobalError(null)}
              className="text-rose-600 hover:text-rose-800 font-bold text-xs cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main App Content View */}
      <main className="flex-1">
        {activeTab === 'topics' && (
          <MyTopicsView
            savedProjects={projects}
            currentProjectId={currentProjectId}
            onOpenProject={handleOpenProject}
            onDeleteProject={handleDeleteProject}
            onDuplicateProject={handleDuplicateProject}
            onCreateNewTopic={handleCreateNewTopic}
          />
        )}

        {activeTab === 'sources' && (
          <SourceManager
            sources={currentProject.sources}
            onAddSource={handleAddSource}
            onRemoveSource={handleRemoveSource}
            onClearSources={handleClearSources}
            topicTitle={currentProject.title}
            setTopicTitle={setTopicTitle}
            language={currentProject.language}
            setLanguage={setLanguage}
            teachingStyle={currentProject.teachingStyle}
            setTeachingStyle={setTeachingStyle}
            customInstruction={currentProject.customInstruction}
            setCustomInstruction={setCustomInstruction}
            allowWebSearch={currentProject.allowWebSearch}
            setAllowWebSearch={setAllowWebSearch}
            onGenerateAll={handleGenerateAll}
            isLoading={isLoading}
            loadingStep={loadingStep}
          />
        )}

        {activeTab === 'teach' && (
          <LessonTutorView
            lesson={currentProject.lesson}
            sources={currentProject.sources}
            topicTitle={currentProject.title}
            onGoToNotes={() => setActiveTab('notes')}
            onGoToQuiz={() => setActiveTab('quiz')}
            chatHistory={currentProject.chatHistory || []}
            setChatHistory={(newChat) => {
              updateCurrentProject((p) => ({
                ...p,
                chatHistory: typeof newChat === 'function' ? newChat(p.chatHistory || []) : newChat,
              }));
            }}
            onUpdateSection={handleUpdateSection}
            completedSectionIds={currentProject.progress?.completedSectionIds || []}
            passedCheckpointIds={currentProject.progress?.passedCheckpointIds || []}
            onToggleSectionCompleted={(sectionId) => {
              updateCurrentProject((p) => {
                const prog = p.progress || getDefaultTopicProgress();
                const isCompleted = prog.completedSectionIds.includes(sectionId);
                const updatedIds = isCompleted 
                  ? prog.completedSectionIds.filter(id => id !== sectionId)
                  : [...prog.completedSectionIds, sectionId];
                return { ...p, progress: { ...prog, completedSectionIds: updatedIds, lastStudiedAt: Date.now() } };
              });
            }}
            onCheckpointPassed={(sectionId) => {
              updateCurrentProject((p) => {
                const prog = p.progress || getDefaultTopicProgress();
                if (!prog.passedCheckpointIds.includes(sectionId)) {
                  return { ...p, progress: { ...prog, passedCheckpointIds: [...prog.passedCheckpointIds, sectionId], lastStudiedAt: Date.now() } };
                }
                return p;
              });
            }}
            onIncrementStudyTime={(seconds) => {
              updateCurrentProject((p) => {
                const prog = p.progress || getDefaultTopicProgress();
                const todayKey = getLocalDateKey();
                const daily = prog.dailyStudyTime || {};
                return {
                  ...p,
                  progress: {
                    ...prog,
                    totalStudyTimeSeconds: (prog.totalStudyTimeSeconds || 0) + seconds,
                    dailyStudyTime: {
                      ...daily,
                      [todayKey]: (daily[todayKey] || 0) + seconds,
                    },
                    lastStudiedAt: Date.now(),
                  },
                };
              });
            }}
            language={currentProject.language}
            teachingStyle={currentProject.teachingStyle}
            allowWebSearch={currentProject.allowWebSearch}
          />
        )}

        {activeTab === 'notes' && (
          <InteractiveNotesView
            notes={currentProject.notes}
            topicTitle={currentProject.title}
            language={currentProject.language}
            onGoToQuiz={() => setActiveTab('quiz')}
            onRegenerateNotes={handleRegenerateNotes}
            isRegeneratingNotes={isRegeneratingNotes}
            onIncrementStudyTime={(seconds) => {
              updateCurrentProject((p) => {
                const prog = p.progress || getDefaultTopicProgress();
                const todayKey = getLocalDateKey();
                const daily = prog.dailyStudyTime || {};
                return {
                  ...p,
                  progress: {
                    ...prog,
                    totalStudyTimeSeconds: (prog.totalStudyTimeSeconds || 0) + seconds,
                    dailyStudyTime: {
                      ...daily,
                      [todayKey]: (daily[todayKey] || 0) + seconds,
                    },
                    lastStudiedAt: Date.now(),
                  },
                };
              });
            }}
            onUpdateFlashcards={(updatedCards) => {
              if (currentProject.notes) {
                updateCurrentProject((p) => ({
                  ...p,
                  notes: p.notes ? { ...p.notes, flashcards: updatedCards } : undefined,
                }));
              }
            }}
          />
        )}

        {activeTab === 'quiz' && (
          <QuizPracticeView
            currentQuiz={currentProject.quiz}
            sources={currentProject.sources}
            topicTitle={currentProject.title}
            onSetQuiz={(newQuiz) => {
              updateCurrentProject((p) => ({
                ...p,
                quiz: newQuiz,
              }));
            }}
            onGoToLesson={() => setActiveTab('teach')}
            onGoToNotes={() => setActiveTab('notes')}
            onQuizAttemptCompleted={(score, total, timeSpentSecs) => {
              updateCurrentProject((p) => {
                const prog = p.progress || getDefaultTopicProgress();
                const todayKey = getLocalDateKey();
                const daily = prog.dailyStudyTime || {};
                const newAttempt = { 
                  id: Math.random().toString(36).substring(2, 9),
                  timestamp: Date.now(), 
                  score, 
                  correctCount: Math.round((score / 100) * total),
                  totalQuestions: total, 
                  timeSpentSeconds: timeSpentSecs 
                };
                return { 
                  ...p, 
                  progress: { 
                    ...prog, 
                    quizAttempts: [...prog.quizAttempts, newAttempt],
                    totalStudyTimeSeconds: (prog.totalStudyTimeSeconds || 0) + timeSpentSecs,
                    dailyStudyTime: {
                      ...daily,
                      [todayKey]: (daily[todayKey] || 0) + timeSpentSecs,
                    },
                    lastStudiedAt: Date.now()
                  } 
                };
              });
            }}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white/80 py-4 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-medium">
            <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
            <span>ReviseAI • Socratic Revision & Learning Companion</span>
          </p>
          <p className="text-slate-400">
            Source-Grounded • Active Recall • Multiple Languages • Step-by-Step Mastery
          </p>
        </div>
      </footer>
    </div>
  );
}

