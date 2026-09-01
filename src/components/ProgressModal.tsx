import React, { useState } from 'react';
import {
  X,
  Trophy,
  CheckCircle2,
  BookOpen,
  Layers,
  HelpCircle,
  Clock,
  ArrowRight,
  TrendingUp,
  RotateCcw,
  Sparkles,
  Flame,
  Award,
  ChevronRight,
  Calendar,
  BarChart2
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell
} from 'recharts';
import { RevisionProject } from '../types';
import { calculateTopicMastery, calculate7DayStudyStats, formatTimeSpent, DailyStudyPoint } from '../utils/progress';

interface ProgressModalProps {
  project?: RevisionProject;
  allProjects?: RevisionProject[];
  isOpen: boolean;
  onClose: () => void;
  onNavigateTab: (tab: 'sources' | 'teach' | 'notes' | 'quiz') => void;
  onResetProgress?: () => void;
}

const CustomStudyTooltip: React.FC<{
  active?: boolean;
  payload?: any[];
  label?: string;
}> = ({ active, payload }) => {
  if (active && payload && payload.length > 0) {
    const data = payload[0].payload as DailyStudyPoint;
    return (
      <div className="bg-slate-900/95 text-white p-3 rounded-xl shadow-2xl border border-slate-700 text-xs backdrop-blur-md min-w-[170px] z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between gap-2 border-b border-slate-700/80 pb-1.5 mb-2 font-medium text-slate-300">
          <span className="font-semibold">{data.fullDate}</span>
          {data.isToday && (
            <span className="bg-indigo-500/30 text-indigo-300 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-indigo-400/30">
              Today
            </span>
          )}
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Study Time:</span>
            <span className="font-bold text-indigo-300 text-sm">
              {data.seconds > 0 ? formatTimeSpent(data.seconds) : '0m (No activity)'}
            </span>
          </div>
          {data.quizAttempts > 0 && (
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800 text-[11px] text-amber-300">
              <span className="text-slate-400">Exam Quizzes:</span>
              <span className="font-semibold">{data.quizAttempts} taken</span>
            </div>
          )}
        </div>
      </div>
    );
  }
  return null;
};

export const ProgressModal: React.FC<ProgressModalProps> = ({
  project,
  allProjects = [],
  isOpen,
  onClose,
  onNavigateTab,
  onResetProgress,
}) => {
  const [chartScope, setChartScope] = useState<'current' | 'all'>('current');

  if (!isOpen || !project) return null;

  const stats = calculateTopicMastery(project);
  const quizAttempts = project.progress?.quizAttempts || [];
  const studySummary = calculate7DayStudyStats(project, allProjects, chartScope);

  const hasMultipleProjects = allProjects && allProjects.length > 1;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl max-w-2xl w-full shadow-2xl border border-slate-200 overflow-hidden my-8 animate-in fade-in zoom-in-95 duration-200">
        {/* Modal Header */}
        <div className="bg-gradient-to-br from-indigo-900 via-indigo-800 to-slate-900 p-6 sm:p-8 text-white relative">
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="absolute top-5 right-5 p-2 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2 mb-2">
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-indigo-500/40 text-indigo-200 border border-indigo-400/30 flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-amber-300" />
              Topic Progress & Mastery Report
            </span>
          </div>

          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white line-clamp-1 mb-4">
            {project.title || 'Revision Topic'}
          </h2>

          {/* Large Mastery Score Display */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t border-white/15">
            <div className="flex items-center gap-4">
              <div className="relative flex items-center justify-center w-16 h-16 rounded-2xl bg-white/10 border border-white/20 text-white font-black text-2xl">
                {stats.overallMasteryScore}%
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-white">{stats.masteryTier}</span>
                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${stats.tierBg}`}>
                    Tier
                  </span>
                </div>
                <p className="text-xs text-indigo-200">
                  Calculated from lesson chapters, active flashcards, and exam scores.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs bg-white/10 px-3.5 py-2 rounded-xl border border-white/15">
              <Clock className="w-4 h-4 text-indigo-300" />
              <span>
                <strong>{stats.studyTimeMinutes}</strong> mins active study
              </span>
            </div>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 sm:p-8 space-y-6 max-h-[60vh] overflow-y-auto">
          {/* 7-Day Study Time Recharts Section */}
          <div className="bg-slate-50 border border-slate-200/90 rounded-2xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center">
                  <BarChart2 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <span>Study Activity (Last 7 Days)</span>
                    <span className="text-xs font-normal text-slate-500">• {studySummary.formattedTotalTime} total</span>
                  </h3>
                  <p className="text-[11px] text-slate-500">Daily study time breakdown across active revision sessions</p>
                </div>
              </div>

              {hasMultipleProjects && (
                <div className="flex items-center bg-white p-0.5 rounded-lg border border-slate-200 text-xs self-start sm:self-auto">
                  <button
                    type="button"
                    onClick={() => setChartScope('current')}
                    className={`px-2.5 py-1 rounded-md font-medium transition-all cursor-pointer ${
                      chartScope === 'current'
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    This Topic
                  </button>
                  <button
                    type="button"
                    onClick={() => setChartScope('all')}
                    className={`px-2.5 py-1 rounded-md font-medium transition-all cursor-pointer ${
                      chartScope === 'all'
                        ? 'bg-indigo-600 text-white shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    All Topics
                  </button>
                </div>
              )}
            </div>

            {/* 4 Stat KPI Chips */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
              <div className="bg-white border border-slate-200/80 rounded-xl p-2.5">
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">7-Day Total</p>
                <p className="text-base font-bold text-indigo-950 mt-0.5">{studySummary.formattedTotalTime}</p>
              </div>

              <div className="bg-white border border-slate-200/80 rounded-xl p-2.5">
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Daily Avg</p>
                <p className="text-base font-bold text-slate-900 mt-0.5">{studySummary.averageDailyMinutes} <span className="text-xs font-normal text-slate-500">m/day</span></p>
              </div>

              <div className="bg-white border border-slate-200/80 rounded-xl p-2.5">
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Active Days</p>
                <p className="text-base font-bold text-slate-900 mt-0.5">{studySummary.activeDaysCount} <span className="text-xs font-normal text-slate-500">of 7</span></p>
              </div>

              <div className="bg-white border border-slate-200/80 rounded-xl p-2.5">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Streak</p>
                  <Flame className="w-3.5 h-3.5 text-amber-500" />
                </div>
                <p className="text-base font-bold text-amber-600 mt-0.5">
                  {studySummary.studyStreakDays} <span className="text-xs font-normal text-slate-500">{studySummary.studyStreakDays === 1 ? 'day' : 'days'}</span>
                </p>
              </div>
            </div>

            {/* Recharts Bar Chart */}
            <div className="bg-white border border-slate-200/80 rounded-xl p-4 pt-5">
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={studySummary.dailyData}
                    margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F1F5F9" />
                    <XAxis
                      dataKey="dayLabel"
                      tick={{ fontSize: 11, fill: '#64748B', fontWeight: 500 }}
                      axisLine={{ stroke: '#E2E8F0' }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#94A3B8' }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(val) => `${val}m`}
                      domain={[0, 'auto']}
                    />
                    <Tooltip content={<CustomStudyTooltip />} cursor={{ fill: '#F8FAFC', radius: 6 }} />
                    <Bar
                      dataKey="minutes"
                      radius={[6, 6, 2, 2]}
                      animationDuration={700}
                    >
                      {studySummary.dailyData.map((entry, index) => {
                        let barFill = '#4F46E5'; // Default Indigo
                        if (entry.isToday) {
                          barFill = '#6366F1'; // Highlighted Today Indigo
                        } else if (entry.minutes === 0) {
                          barFill = '#E2E8F0'; // Empty day placeholder
                        }
                        return <Cell key={`cell-${index}`} fill={barFill} />;
                      })}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {studySummary.totalSeconds === 0 && (
                <p className="text-center text-xs text-slate-400 mt-2">
                  No active study recorded in this period yet. Time spent reading lessons, reviewing flashcards, and taking quizzes will appear here automatically.
                </p>
              )}
            </div>
          </div>

          {/* Next Recommended Step Card */}
          <div className="bg-indigo-50/80 border border-indigo-200 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center flex-shrink-0 shadow-xs mt-0.5">
                <Flame className="w-5 h-5 text-amber-300" />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-bold text-indigo-700 uppercase tracking-wider">Next Recommended Step</span>
                </div>
                <h4 className="text-sm font-bold text-slate-900 mt-0.5">{stats.nextRecommendedAction.title}</h4>
                <p className="text-xs text-slate-600 mt-0.5">{stats.nextRecommendedAction.description}</p>
              </div>
            </div>

            <button
              onClick={() => {
                onNavigateTab(stats.nextRecommendedAction.targetTab);
                onClose();
              }}
              className="flex-shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-xs transition-all cursor-pointer"
            >
              <span>{stats.nextRecommendedAction.actionText}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 3 Main Pillars Breakdown */}
          <div className="space-y-4">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Core Revision Pillars
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              {/* 1. Lesson Reading */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-4 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center">
                      <BookOpen className="w-4 h-4" />
                    </div>
                    <span className="text-xs font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-200">
                      {stats.lessonPercentage}%
                    </span>
                  </div>
                  <h4 className="text-sm font-bold text-slate-900">Lesson Chapters</h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {stats.lessonCompletedCount} of {stats.lessonTotalCount} completed
                  </p>
                </div>

                <div className="mt-3">
                  <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden mb-2">
                    <div
                      className="bg-indigo-600 h-full transition-all duration-300 rounded-full"
                      style={{ width: `${stats.lessonPercentage}%` }}
                    />
                  </div>
                  <button
                    onClick={() => {
                      onNavigateTab('teach');
                      onClose();
                    }}
                    className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 cursor-pointer"
                  >
                    <span>Read Lessons</span>
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>

              {/* 2. Flashcards */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-4 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
                      <Layers className="w-4 h-4" />
                    </div>
                    <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                      {stats.flashcardsPercentage}%
                    </span>
                  </div>
                  <h4 className="text-sm font-bold text-slate-900">Flashcards</h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {stats.flashcardsMastered} of {stats.flashcardsTotal} mastered
                  </p>
                </div>

                <div className="mt-3">
                  <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden mb-2">
                    <div
                      className="bg-emerald-600 h-full transition-all duration-300 rounded-full"
                      style={{ width: `${stats.flashcardsPercentage}%` }}
                    />
                  </div>
                  <button
                    onClick={() => {
                      onNavigateTab('notes');
                      onClose();
                    }}
                    className="text-[11px] font-bold text-emerald-600 hover:text-emerald-800 flex items-center gap-1 cursor-pointer"
                  >
                    <span>Review Cards</span>
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>

              {/* 3. Quiz Practice */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-4 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-600 flex items-center justify-center">
                      <HelpCircle className="w-4 h-4" />
                    </div>
                    <span className="text-xs font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
                      {stats.bestQuizScore !== null ? `${stats.bestQuizScore}%` : 'Not Taken'}
                    </span>
                  </div>
                  <h4 className="text-sm font-bold text-slate-900">Exam Quizzes</h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {stats.quizAttemptsCount} attempts recorded
                  </p>
                </div>

                <div className="mt-3">
                  <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden mb-2">
                    <div
                      className="bg-amber-500 h-full transition-all duration-300 rounded-full"
                      style={{ width: `${stats.bestQuizScore || 0}%` }}
                    />
                  </div>
                  <button
                    onClick={() => {
                      onNavigateTab('quiz');
                      onClose();
                    }}
                    className="text-[11px] font-bold text-amber-600 hover:text-amber-800 flex items-center gap-1 cursor-pointer"
                  >
                    <span>Take Practice Quiz</span>
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Quiz Attempts History Log */}
          {quizAttempts.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center justify-between">
                <span>Quiz Performance History</span>
                <span className="text-slate-400 font-normal">{quizAttempts.length} past attempts</span>
              </h3>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-2xl overflow-hidden text-xs">
                {quizAttempts.slice(-5).reverse().map((att, idx) => (
                  <div key={att.id || idx} className="p-3 bg-white flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs ${
                        att.score >= 80 ? 'bg-emerald-100 text-emerald-800' : att.score >= 60 ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'
                      }`}>
                        {att.score}%
                      </span>
                      <div>
                        <p className="font-semibold text-slate-800">
                          {att.correctCount} of {att.totalQuestions} Questions Correct
                        </p>
                        <p className="text-[11px] text-slate-400">
                          {new Date(att.timestamp).toLocaleDateString()} • {Math.round(att.timeSpentSeconds / 60)}m {att.timeSpentSeconds % 60}s taken
                        </p>
                      </div>
                    </div>
                    {att.score === stats.bestQuizScore && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                        <Trophy className="w-3 h-3 text-amber-500" />
                        Best
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 sm:p-6 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs">
          {onResetProgress ? (
            <button
              onClick={() => {
                if (window.confirm('Are you sure you want to reset all progress tracking for this topic?')) {
                  onResetProgress();
                }
              }}
              className="text-slate-400 hover:text-rose-600 transition-colors flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset Topic Progress</span>
            </button>
          ) : <div />}

          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

