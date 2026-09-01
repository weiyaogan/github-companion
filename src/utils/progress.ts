import { RevisionProject, TopicProgress, QuizAttemptRecord } from '../types';

export interface TopicMasteryStats {
  lessonCompletedCount: number;
  lessonTotalCount: number;
  lessonPercentage: number;
  
  flashcardsMastered: number;
  flashcardsLearning: number;
  flashcardsUnreviewed: number;
  flashcardsTotal: number;
  flashcardsPercentage: number;

  bestQuizScore: number | null;
  latestQuizScore: number | null;
  quizAttemptsCount: number;
  quizTotalQuestions: number;

  overallMasteryScore: number; // 0 to 100
  masteryTier: 'Unstarted' | 'Getting Started' | 'Developing' | 'Proficient' | 'Mastered';
  tierColor: string; // Tailwind color class
  tierBg: string;

  studyTimeMinutes: number;
  nextRecommendedAction: {
    title: string;
    description: string;
    targetTab: 'sources' | 'teach' | 'notes' | 'quiz';
    actionText: string;
  };
}

export function getDefaultTopicProgress(): TopicProgress {
  return {
    completedSectionIds: [],
    passedCheckpointIds: [],
    flashcardStatuses: {},
    quizAttempts: [],
    totalStudyTimeSeconds: 0,
    lastStudiedAt: Date.now(),
  };
}

export function calculateTopicMastery(project?: RevisionProject): TopicMasteryStats {
  if (!project) {
    return {
      lessonCompletedCount: 0,
      lessonTotalCount: 0,
      lessonPercentage: 0,
      flashcardsMastered: 0,
      flashcardsLearning: 0,
      flashcardsUnreviewed: 0,
      flashcardsTotal: 0,
      flashcardsPercentage: 0,
      bestQuizScore: null,
      latestQuizScore: null,
      quizAttemptsCount: 0,
      quizTotalQuestions: 0,
      overallMasteryScore: 0,
      masteryTier: 'Unstarted',
      tierColor: 'text-slate-500',
      tierBg: 'bg-slate-100 text-slate-700',
      studyTimeMinutes: 0,
      nextRecommendedAction: {
        title: 'Add Study Sources',
        description: 'Import study materials or notes to generate your revision workspace.',
        targetTab: 'sources',
        actionText: 'Add Sources',
      },
    };
  }

  const progress = project.progress || getDefaultTopicProgress();

  // 1. Lesson Progress
  const totalSections = project.lesson?.sections?.length || 0;
  const validCompletedSections = (progress.completedSectionIds || []).filter(
    (id) => !project.lesson?.sections || project.lesson.sections.some((s) => s.id === id)
  );
  const lessonCompletedCount = Math.min(validCompletedSections.length, totalSections);
  const lessonPercentage = totalSections > 0 ? Math.round((lessonCompletedCount / totalSections) * 100) : 0;

  // 2. Flashcard Progress
  const allCards = project.notes?.flashcards || [];
  const flashcardsTotal = allCards.length;
  let flashcardsMastered = 0;
  let flashcardsLearning = 0;

  allCards.forEach((c) => {
    const status = progress.flashcardStatuses?.[c.id] || c.userStatus || 'unreviewed';
    if (status === 'mastered') flashcardsMastered++;
    else if (status === 'learning') flashcardsLearning++;
  });

  const flashcardsUnreviewed = Math.max(0, flashcardsTotal - flashcardsMastered - flashcardsLearning);
  const flashcardsPercentage = flashcardsTotal > 0 ? Math.round((flashcardsMastered / flashcardsTotal) * 100) : 0;

  // 3. Quiz Performance
  const quizAttempts = progress.quizAttempts || [];
  const quizAttemptsCount = quizAttempts.length;
  const bestQuizScore = progress.bestQuizScore ?? (quizAttempts.length > 0 ? Math.max(...quizAttempts.map((q) => q.score)) : null);
  const latestQuizScore = progress.latestQuizScore ?? (quizAttempts.length > 0 ? quizAttempts[quizAttempts.length - 1].score : null);
  const quizTotalQuestions = project.quiz?.questions?.length || 0;

  // 4. Overall Weighted Mastery Calculation
  let overallMasteryScore = 0;
  const hasLesson = totalSections > 0;
  const hasCards = flashcardsTotal > 0;
  const hasQuiz = quizTotalQuestions > 0;

  if (hasLesson && hasCards && hasQuiz) {
    const quizComponent = bestQuizScore !== null ? bestQuizScore : 0;
    overallMasteryScore = Math.round(lessonPercentage * 0.3 + flashcardsPercentage * 0.35 + quizComponent * 0.35);
  } else if (hasLesson && hasCards) {
    overallMasteryScore = Math.round(lessonPercentage * 0.45 + flashcardsPercentage * 0.55);
  } else if (hasCards && hasQuiz) {
    const quizComponent = bestQuizScore !== null ? bestQuizScore : 0;
    overallMasteryScore = Math.round(flashcardsPercentage * 0.5 + quizComponent * 0.5);
  } else if (hasLesson) {
    overallMasteryScore = lessonPercentage;
  } else if (hasCards) {
    overallMasteryScore = flashcardsPercentage;
  } else if (hasQuiz) {
    overallMasteryScore = bestQuizScore ?? 0;
  }

  overallMasteryScore = Math.min(100, Math.max(0, overallMasteryScore));

  // Mastery Tier
  let masteryTier: TopicMasteryStats['masteryTier'] = 'Unstarted';
  let tierColor = 'text-slate-500';
  let tierBg = 'bg-slate-100 text-slate-700 border-slate-200';

  if (overallMasteryScore >= 90) {
    masteryTier = 'Mastered';
    tierColor = 'text-emerald-700';
    tierBg = 'bg-emerald-50 text-emerald-800 border-emerald-200';
  } else if (overallMasteryScore >= 70) {
    masteryTier = 'Proficient';
    tierColor = 'text-indigo-700';
    tierBg = 'bg-indigo-50 text-indigo-800 border-indigo-200';
  } else if (overallMasteryScore >= 40) {
    masteryTier = 'Developing';
    tierColor = 'text-amber-700';
    tierBg = 'bg-amber-50 text-amber-800 border-amber-200';
  } else if (overallMasteryScore > 0 || (project.sources && project.sources.length > 0)) {
    masteryTier = 'Getting Started';
    tierColor = 'text-blue-700';
    tierBg = 'bg-blue-50 text-blue-800 border-blue-200';
  }

  // Next Recommended Action
  let nextRecommendedAction: TopicMasteryStats['nextRecommendedAction'] = {
    title: 'Start Learning & Revision',
    description: 'Begin exploring the step-by-step lesson chapters.',
    targetTab: 'teach',
    actionText: 'Open Lesson',
  };

  if (!project.lesson && (!project.sources || project.sources.length === 0)) {
    nextRecommendedAction = {
      title: 'Import Study Materials',
      description: 'Add your study link, PDF notes, or lecture slides to generate the revision pack.',
      targetTab: 'sources',
      actionText: 'Add Sources',
    };
  } else if (lessonPercentage < 100 && totalSections > 0) {
    const nextChapterIndex = project.lesson?.sections.findIndex(
      (s) => !validCompletedSections.includes(s.id)
    );
    const chapterNum = nextChapterIndex !== undefined && nextChapterIndex >= 0 ? nextChapterIndex + 1 : 1;
    nextRecommendedAction = {
      title: `Complete Chapter ${chapterNum}`,
      description: `Read through chapter ${chapterNum} and pass the checkpoint knowledge check.`,
      targetTab: 'teach',
      actionText: `Study Chapter ${chapterNum}`,
    };
  } else if (flashcardsPercentage < 80 && flashcardsTotal > 0) {
    const unmastered = flashcardsTotal - flashcardsMastered;
    nextRecommendedAction = {
      title: `Master Remaining Flashcards`,
      description: `You have ${unmastered} flashcards left to master using spaced active recall.`,
      targetTab: 'notes',
      actionText: 'Practice Flashcards',
    };
  } else if (bestQuizScore === null || bestQuizScore < 80) {
    nextRecommendedAction = {
      title: bestQuizScore === null ? 'Take Practice Quiz' : 'Improve Exam Score',
      description:
        bestQuizScore === null
          ? 'Test your active recall with adaptive exam questions and AI marking rubrics.'
          : `Current high score: ${bestQuizScore}%. Aim for 85%+ to achieve full mastery!`,
      targetTab: 'quiz',
      actionText: 'Take Practice Quiz',
    };
  } else {
    nextRecommendedAction = {
      title: 'Topic Mastered! 🎉',
      description: 'You have achieved over 90% topic mastery. Retake practice questions periodically to maintain retention.',
      targetTab: 'quiz',
      actionText: 'Retake Quiz for Retention',
    };
  }

  const studyTimeMinutes = Math.max(0, Math.round((progress.totalStudyTimeSeconds || 0) / 60));

  return {
    lessonCompletedCount,
    lessonTotalCount: totalSections,
    lessonPercentage,
    flashcardsMastered,
    flashcardsLearning,
    flashcardsUnreviewed,
    flashcardsTotal,
    flashcardsPercentage,
    bestQuizScore,
    latestQuizScore,
    quizAttemptsCount,
    quizTotalQuestions,
    overallMasteryScore,
    masteryTier,
    tierColor,
    tierBg,
    studyTimeMinutes,
    nextRecommendedAction,
  };
}

export interface DailyStudyPoint {
  dateKey: string;
  dayLabel: string;
  shortDate: string;
  fullDate: string;
  seconds: number;
  minutes: number;
  quizAttempts: number;
  isToday: boolean;
}

export interface SevenDayStudySummary {
  dailyData: DailyStudyPoint[];
  totalSeconds: number;
  totalMinutes: number;
  formattedTotalTime: string;
  averageDailyMinutes: number;
  bestDay: { dayLabel: string; fullDate: string; minutes: number } | null;
  activeDaysCount: number;
  studyStreakDays: number;
}

export function formatTimeSpent(seconds: number): string {
  if (!seconds || seconds <= 0) return '0m';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  if (mins > 0) {
    return `${mins}m ${secs > 0 && mins < 5 ? `${secs}s` : ''}`.trim();
  }
  return `${secs}s`;
}

export function getLocalDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function calculate7DayStudyStats(
  project?: RevisionProject,
  allProjects?: RevisionProject[],
  scope: 'current' | 'all' = 'current'
): SevenDayStudySummary {
  const projectsToInclude =
    scope === 'all' && allProjects && allProjects.length > 0
      ? allProjects
      : project
      ? [project]
      : [];

  // Generate 7-day calendar window (today and previous 6 days)
  const daysMap = new Map<string, { date: Date; seconds: number; quizCount: number; isToday: boolean }>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const dateKey = getLocalDateKey(d);
    daysMap.set(dateKey, {
      date: d,
      seconds: 0,
      quizCount: 0,
      isToday: i === 0,
    });
  }

  // Aggregate study time from projects
  projectsToInclude.forEach((p) => {
    const prog = p.progress;
    if (!prog) return;

    // 1. Check dailyStudyTime map
    if (prog.dailyStudyTime) {
      Object.entries(prog.dailyStudyTime).forEach(([dateKey, secs]) => {
        if (daysMap.has(dateKey)) {
          const current = daysMap.get(dateKey)!;
          current.seconds += Number(secs) || 0;
        }
      });
    } else if (prog.totalStudyTimeSeconds > 0) {
      // Fallback for legacy topics without daily breakdown: attribute to lastStudiedAt or today
      const studiedDate = prog.lastStudiedAt ? new Date(prog.lastStudiedAt) : new Date(p.updatedAt || p.createdAt || Date.now());
      const key = getLocalDateKey(studiedDate);
      if (daysMap.has(key)) {
        const current = daysMap.get(key)!;
        current.seconds += prog.totalStudyTimeSeconds;
      } else {
        // If outside the 7 day window, attribute to the closest day or today
        const todayKey = getLocalDateKey(today);
        if (daysMap.has(todayKey)) {
          const current = daysMap.get(todayKey)!;
          current.seconds += prog.totalStudyTimeSeconds;
        }
      }
    }

    // 2. Aggregate quiz attempts
    (prog.quizAttempts || []).forEach((att) => {
      const attDate = new Date(att.timestamp);
      const key = getLocalDateKey(attDate);
      if (daysMap.has(key)) {
        const current = daysMap.get(key)!;
        current.quizCount += 1;
        // If dailyStudyTime was not logged for this quiz attempt time, add it
        if (!prog.dailyStudyTime && att.timeSpentSeconds) {
          current.seconds += att.timeSpentSeconds;
        }
      }
    });
  });

  const dailyData: DailyStudyPoint[] = [];
  let totalSeconds = 0;
  let activeDaysCount = 0;
  let bestDay: SevenDayStudySummary['bestDay'] = null;

  daysMap.forEach((val, dateKey) => {
    totalSeconds += val.seconds;
    const minutes = Math.round((val.seconds / 60) * 10) / 10; // 1 decimal point precision

    if (val.seconds > 0) {
      activeDaysCount++;
    }

    const dayName = dayNames[val.date.getDay()];
    const monthNum = val.date.getMonth() + 1;
    const dayNum = val.date.getDate();
    const shortDate = `${monthNum}/${dayNum}`;
    const dayLabel = val.isToday ? 'Today' : dayName;
    const fullDate = val.date.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

    if (!bestDay || minutes > bestDay.minutes) {
      if (minutes > 0) {
        bestDay = {
          dayLabel,
          fullDate,
          minutes,
        };
      }
    }

    dailyData.push({
      dateKey,
      dayLabel,
      shortDate,
      fullDate,
      seconds: val.seconds,
      minutes,
      quizAttempts: val.quizCount,
      isToday: val.isToday,
    });
  });

  // Calculate current streak (consecutive active days up to today)
  let studyStreakDays = 0;
  for (let i = dailyData.length - 1; i >= 0; i--) {
    if (dailyData[i].seconds > 0) {
      studyStreakDays++;
    } else if (i === dailyData.length - 1) {
      // If today is 0 so far, check if yesterday was active to keep streak alive
      continue;
    } else {
      break;
    }
  }

  const totalMinutes = Math.round(totalSeconds / 60);
  const averageDailyMinutes = Math.round((totalMinutes / 7) * 10) / 10;

  return {
    dailyData,
    totalSeconds,
    totalMinutes,
    formattedTotalTime: formatTimeSpent(totalSeconds),
    averageDailyMinutes,
    bestDay,
    activeDaysCount,
    studyStreakDays,
  };
}
