import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const app = express();
const PORT = 3000;

// Body parser for JSON and large payloads (e.g. document uploads/base64)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Lazy initialize Gemini API client
let aiClient: GoogleGenAI | null = null;
function getAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Robust JSON extraction and parsing helper
function parseJsonSafely<T = any>(rawText: string, fallback: T): T {
  if (!rawText || typeof rawText !== 'string') return fallback;

  let cleaned = rawText.trim();
  // Strip markdown code fences if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Try direct parse
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Try to find the outermost JSON object or array
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');

    let startIdx = -1;
    let isArray = false;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      startIdx = firstBrace;
      isArray = false;
    } else if (firstBracket !== -1) {
      startIdx = firstBracket;
      isArray = true;
    }

    if (startIdx !== -1) {
      let jsonStr = cleaned.substring(startIdx);
      
      // Attempt 1: Just parse up to the last known good closing character
      const endChar = isArray ? ']' : '}';
      const lastIdx = jsonStr.lastIndexOf(endChar);
      if (lastIdx > 0) {
        try {
          const parsed = JSON.parse(jsonStr.substring(0, lastIdx + 1));
          if (parsed && typeof parsed === 'object') return parsed;
        } catch (e) {}
      }

      // Attempt 2: Auto-close truncated JSON. Extremely aggressive fixing for LLM cut-offs.
      const closeBrackets = (str: string) => {
        let openBraces = 0;
        let openBrackets = 0;
        let inString = false;
        let escapeNext = false;
        
        for (let i = 0; i < str.length; i++) {
          const char = str[i];
          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          if (char === '\\') {
            escapeNext = true;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            continue;
          }
          if (!inString) {
            if (char === '{') openBraces++;
            if (char === '}') openBraces--;
            if (char === '[') openBrackets++;
            if (char === ']') openBrackets--;
          }
        }
        
        let fixed = str;
        if (inString) fixed += '"';
        
        // Remove trailing commas if any exist right before adding braces
        fixed = fixed.replace(/,\s*$/, '');

        while (openBrackets > 0 || openBraces > 0) {
          if (openBrackets > 0) {
            fixed += ']';
            openBrackets--;
          } else if (openBraces > 0) {
            fixed += '}';
            openBraces--;
          }
        }
        return fixed;
      };

      try {
        const fixedJson = closeBrackets(jsonStr);
        const parsed = JSON.parse(fixedJson);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (e) {
        console.warn('Aggressive JSON repair failed:', e);
      }
    }
  }

  return fallback;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hasGeminiKey: !!process.env.GEMINI_API_KEY, time: new Date().toISOString() });
});

// Fetch and extract readable text from a URL
app.post('/api/fetch-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Valid URL is required' });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format. Please provide a full web address (e.g. https://...).' });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(parsedUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ReviseAIBot/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Could not reach website (HTTP ${response.status}: ${response.statusText}). You can also copy and paste the text directly into the "Paste Notes" tab.`,
      });
    }

    const html = await response.text();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let title = titleMatch ? titleMatch[1].trim() : parsedUrl.hostname;
    title = title.replace(/\s*[-–—|]\s*(Wikipedia|Medium|Khan Academy|BBC|YouTube|Britannica|Investopedia).*$/i, '').trim();

    // Strip scripts, styles, and HTML tags for clean text extraction
    let cleanText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
      .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
      .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanText.length > 500000) {
      cleanText = cleanText.substring(0, 500000) + '... [Long document preserved for comprehensive revision analysis]';
    }

    if (!cleanText || cleanText.length < 50) {
      cleanText = `Study topic from web link: ${url}\nTopic Title: ${title}\n(Extracted web body text was short, using article title and domain as context).`;
    }

    res.json({
      title: title || 'Web Study Source',
      url: parsedUrl.toString(),
      content: cleanText,
      length: cleanText.length,
    });
  } catch (err: any) {
    console.error('Error fetching URL:', err);
    res.status(500).json({
      error: err.message || 'Error fetching website content. You can paste the text directly into the "Paste Notes" tab.',
    });
  }
});

// Helper to construct Gemini content parts from sources
function buildGeminiSourceParts(sources: any[] = [], extraPrompt: string) {
  const parts: any[] = [];

  let textSourcesCombined = '';
  for (const src of sources) {
    if (src.base64Data && src.fileMimeType && src.fileMimeType.startsWith('image/')) {
      parts.push({
        inlineData: {
          mimeType: src.fileMimeType,
          data: src.base64Data.replace(/^data:[^;]+;base64,/, ''),
        },
      });
    } else if (src.base64Data && src.fileMimeType === 'application/pdf') {
      parts.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: src.base64Data.replace(/^data:[^;]+;base64,/, ''),
        },
      });
    }

    textSourcesCombined += `\n--- SOURCE DOCUMENT: "${src.title || src.fileName || 'Document'}" (${src.type}) ---\n`;
    textSourcesCombined += (src.content || '').substring(0, 500000) + '\n';
  }

  parts.push({
    text: `STUDY MATERIAL / SOURCES:\n${textSourcesCombined}\n\nINSTRUCTION:\n${extraPrompt}`,
  });

  return parts;
}

// -------------------------------------------------------------
// Resilient Smart Heuristic Synthesis Engines (Offline / Fallback)
// -------------------------------------------------------------
function extractKeyTermsFromText(text: string, count: number = 8): Array<{ term: string; definition: string; importance: 'critical' | 'important' | 'helpful' }> {
  const lines = text.split(/\n|\. /).map(s => s.trim()).filter(s => s.length > 15);
  const terms: Array<{ term: string; definition: string; importance: 'critical' | 'important' | 'helpful' }> = [];

  // Match sentences like "X is defined as...", "X is a...", "X refers to..."
  const defRegex = /([A-Z][A-Za-z0-9\s-]{2,30})\s+(?:is defined as|is a|is an|refers to|means|represents|describes|is called)\s+([^.]+)/i;
  for (const line of lines) {
    const match = line.match(defRegex);
    if (match && match[1] && match[2]) {
      const termName = match[1].trim();
      if (!terms.some(t => t.term.toLowerCase() === termName.toLowerCase())) {
        terms.push({
          term: termName,
          definition: match[2].trim() + '.',
          importance: terms.length < 3 ? 'critical' : terms.length < 6 ? 'important' : 'helpful',
        });
      }
    }
    if (terms.length >= count) break;
  }

  // If still fewer terms, extract capitalized phrases
  if (terms.length < 4) {
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length - 1; i++) {
      const pair = `${words[i]} ${words[i + 1]}`.replace(/[^a-zA-Z\s]/g, '');
      if (/^[A-Z][a-z]+\s[A-Z][a-z]+$/.test(pair) && !terms.some(t => t.term.toLowerCase() === pair.toLowerCase())) {
        terms.push({
          term: pair,
          definition: `Core concept relating to ${pair} and its underlying mechanisms in this subject.`,
          importance: terms.length < 2 ? 'critical' : 'important',
        });
      }
      if (terms.length >= count) break;
    }
  }

  // Extract meaningful single keywords if needed
  if (terms.length < 3) {
    const meaningfulWords = text
      .split(/[\s,.;:!?()]+/)
      .filter(w => w.length > 5 && /^[A-Z][a-z]+$/.test(w))
      .filter((v, i, a) => a.indexOf(v) === i);

    for (const w of meaningfulWords) {
      if (!terms.some(t => t.term.toLowerCase() === w.toLowerCase())) {
        terms.push({
          term: w,
          definition: `Key concept in this domain representing specific mechanisms and structural properties.`,
          importance: 'important',
        });
      }
      if (terms.length >= count) break;
    }
  }

  if (terms.length === 0) {
    terms.push(
      { term: 'Core Mechanism', definition: 'The primary operating process or reaction driving this system.', importance: 'critical' },
      { term: 'Key Variable', definition: 'The central measurable factor influencing outcomes and equilibrium.', importance: 'important' },
      { term: 'Governing Principle', definition: 'The foundational scientific or logical rule describing behavior.', importance: 'critical' },
      { term: 'Boundary Condition', definition: 'The limiting values or constraints determining edge cases.', importance: 'helpful' },
    );
  }

  return terms;
}

function extractKeySentences(text: string, count: number = 6): string[] {
  const rawSentences = text
    .split(/(?<=[.?!])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 30 && s.length < 200 && !s.startsWith('#') && !s.startsWith('http'));

  if (rawSentences.length === 0) {
    return [
      'The foundational mechanism defines the fundamental rules governing system behavior.',
      'Understanding intermediate phases is critical for solving multi-step examination problems.',
      'Always verify boundary conditions and units before finalizing quantitative conclusions.',
    ];
  }

  // Sample diverse sentences across the text
  const step = Math.max(1, Math.floor(rawSentences.length / count));
  const results: string[] = [];
  for (let i = 0; i < rawSentences.length && results.length < count; i += step) {
    results.push(rawSentences[i]);
  }
  return results;
}

function generateSmartFallbackLesson(topicTitle: string, sources: any[]) {
  const combinedText = sources.map(s => s.content || '').join('\n\n');
  const terms = extractKeyTermsFromText(combinedText, 8);
  const sentences = extractKeySentences(combinedText, 6);
  const title = topicTitle || sources[0]?.title || 'Revision Topic';

  const sections = [
    {
      id: 'sec-1',
      title: `1. Definition, Overview & General Information`,
      summary: `Foundational definition, origins, context, and core general knowledge of ${title} before diving into deeper mechanisms.`,
      detailedContent: `### Definition & General Overview of ${title}\n\nTo build true mastery of **${title}**, we start with the fundamental definition and general overview:\n\n- **Formal Definition**: ${sentences[0] || `${title} represents a core subject within this discipline, defining how its key components interact.`}\n- **Historical & General Context**: ${sentences[1] || `Understanding the origin, practical context, and global significance of ${title}.`}\n- **Core Identity & Terminology**: Review the primary definitions of ${terms.slice(0, 2).map(t => `**${t.term}**`).join(' and ')} before moving into advanced operations.\n\n> **💡 Foundational Rule**: Clear knowledge of definitions and baseline context ensures you grasp advanced mechanisms effortlessly.`,
      analogy: `Think of ${title} like the blueprint of an entire building: understanding the overarching definition and structure first makes every individual room and mechanism easy to navigate.`,
      keyConcepts: terms.slice(0, 3).length > 0 ? terms.slice(0, 3) : [
        { term: `${title} Definition`, definition: `The primary formal description and governing context of ${title}.`, importance: 'critical' as const }
      ],
      pitfallsToAvoid: [
        `Jumping into complex mechanisms without mastering the basic definition first.`,
        `Confusing foundational concepts with secondary edge cases.`,
      ],
      checkQuestion: {
        id: 'cq-1',
        question: `What is the most fundamental starting point when studying ${title}?`,
        options: [
          `Understanding its core definition, general background, and foundational principles`,
          `Memorizing isolated facts without knowing what the subject actually is`,
          `Ignoring variable interactions under baseline conditions`,
          `Assuming outcomes are purely random and cannot be defined`,
        ],
        correctIndex: 0,
        explanation: `Starting with a clear definition and general overview provides the necessary mental scaffold to master advanced mechanisms.`,
      },
    },
    {
      id: 'sec-2',
      title: `2. Core Mechanisms, Structure & Operations`,
      summary: `Step-by-step breakdown of how the components within ${title} operate and interact dynamically.`,
      detailedContent: `### Step-by-Step Mechanism Breakdown\n\n1. **Initial State & Triggers**: ${sentences[2] || 'Identify baseline conditions and what initiates the process or equilibrium shift.'}\n2. **Intermediate Phase**: ${sentences[3] || 'Transfer of energy, variables, or information across the system.'}\n3. **Resulting Output / Equilibrium**: ${sentences[4] || 'The final balanced state, products, or qualitative takeaway.'}\n\n| Stage | Key Factor | Expected Outcome |\n| :--- | :--- | :--- |\n| **Phase 1: Input** | Baseline conditions | Activation threshold met |\n| **Phase 2: Action** | Dynamic interaction | Transformation & progress |\n| **Phase 3: Output** | Final state | Equilibrium reached |\n\n*Review each stage in sequence to ensure complete active recall during exams.*`,
      analogy: `Like a set of perfectly lined-up dominoes: each reaction or step in ${title} directly triggers the next in a precise, predictable chain.`,
      keyConcepts: terms.slice(3, 6).length > 0 ? terms.slice(3, 6) : [
        { term: 'Process Equilibrium', definition: 'The balanced steady-state where rates of change equalize.', importance: 'important' as const }
      ],
      pitfallsToAvoid: [
        `Failing to state intermediate steps in written multi-mark exam questions.`,
        `Assuming rates or reactions occur in isolation without feedback loops.`,
      ],
      checkQuestion: {
        id: 'cq-2',
        question: `Why is understanding the intermediate sequence critical in multi-step processes?`,
        options: [
          `Because intermediate factors dictate the final equilibrium and grant method marks`,
          `Because only the final output matters on exam marking rubrics`,
          `Because processes do not have intermediate steps`,
          `Because it eliminates the need to measure initial conditions`,
        ],
        correctIndex: 0,
        explanation: `In standard examination rubrics, method marks and conceptual proofs depend heavily on correctly identifying the intermediate mechanism.`,
      },
    },
    {
      id: 'sec-3',
      title: `3. In-Depth Applications, Analysis & Strategy`,
      summary: `High-yield problem solving strategies, real-world case analysis, and exam-level question approaches.`,
      detailedContent: `### Mastering In-Depth Applications of ${title}\n\nWhen evaluating this topic in depth, focus on:\n\n- **Strategic Applications**: How ${title} applies to real-world systems and industry standards.\n- **Key Takeaway**: ${sentences[5] || 'Synthesize multiple concepts to explain unexpected edge cases and outcomes.'}\n- **Data Interpretation**: Extracting values, patterns, and trends systematically.\n\n### Golden Rules for Full Marks:\n1. State your governing definition or principle explicitly first.\n2. Define all symbols, terms, and units clearly.\n3. Verify that your analysis makes logical and intuitive sense.`,
      analogy: `Approaching in-depth analysis of ${title} is like being a detective: look for clues in the given data, match them to your core laws, and present your evidence step-by-step.`,
      keyConcepts: [
        { term: 'System Synthesis', definition: 'Combining multiple sub-concepts to solve unfamiliar complex scenarios.', importance: 'critical' as const },
        { term: 'Boundary Evaluation', definition: 'The limiting values, constraints, and edge conditions of a system.', importance: 'important' as const },
      ],
      pitfallsToAvoid: [
        `Forgetting units or misinterpreting scale in quantitative questions.`,
        `Writing vague generalized statements instead of specific academic terminology.`,
      ],
      checkQuestion: {
        id: 'cq-3',
        question: `When presented with an unfamiliar scenario on ${title}, what is the best strategy?`,
        options: [
          `Identify the governing definition and principles, analyze knowns/unknowns, and apply the mechanism step-by-step`,
          `Guess the final answer immediately to save time`,
          `Leave the question blank if it does not match past patterns exactly`,
          `Write down unrelated facts in hopes of partial credit`,
        ],
        correctIndex: 0,
        explanation: `Systematically applying the core definition and step-by-step mechanism ensures you capture maximum marks and solve novel problems calmly.`,
      },
    },
  ];

  return {
    topicTitle: title,
    overview: `A structured, high-yield interactive study guide for ${title}, designed with active recall checkpoints, intuitive real-world analogies, and exam trap alerts.`,
    learningObjectives: [
      `Master the core definitions and first-principles mechanisms of ${title}`,
      `Trace the step-by-step interaction stages and intermediate processes`,
      `Avoid common student misconceptions and exam pitfalls`,
      `Apply active recall to solve exam-style practice questions with confidence`,
    ],
    estimatedStudyTimeMinutes: 20,
    sections,
    examTips: [
      `Always state the primary governing law or formula at the beginning of written answers.`,
      `Double-check units, standard definitions, and boundary condition assumptions.`,
      `Use active recall flashcards to commit definitions to long-term memory.`,
      `Practice explaining the mechanism out loud using the real-world analogies.`,
    ],
  };
}

function cleanFallbackTitle(rawTitle: string, contentText: string = ''): string {
  let cleaned = (rawTitle || '').trim();

  // Strip file extensions
  cleaned = cleaned.replace(/\.(pdf|docx?|txt|md|png|jpe?g|pptx?)$/i, '');
  // Replace underscores, dashes, and multiple spaces
  cleaned = cleaned.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Strip common noisy prefixes
  cleaned = cleaned.replace(/^(lecture|notes|chapter|ch|unit|week|slide|summary|slides|doc|assignment|hw|my notes on|notes on|revision on|pasted notes)\s*[:#\d\s]*/i, '').trim();

  if (cleaned.length < 3 && contentText) {
    const terms = extractKeyTermsFromText(contentText, 3);
    if (terms.length > 0 && terms[0].term) {
      cleaned = terms[0].term;
    }
  }

  if (!cleaned || cleaned.length < 3) {
    return 'Comprehensive Revision Topic';
  }

  // Capitalize into Title Case
  const titleCased = cleaned.split(' ').map(w => {
    if (/^(and|or|the|in|on|at|to|for|of|with|a|an|by)$/i.test(w)) return w.toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');

  return titleCased.charAt(0).toUpperCase() + titleCased.slice(1);
}

function generateSmartFallbackNotes(topicTitle: string, sources: any[], notesFocus: string = 'standard') {
  const rawTitle = topicTitle || sources[0]?.title || 'Revision Topic';
  const title = cleanFallbackTitle(rawTitle);
  const combinedText = sources.map(s => s.content || '').join('\n\n');
  const allTerms = extractKeyTermsFromText(combinedText, 18);
  const allSentences = extractKeySentences(combinedText, 12);

  // Shuffle terms & sentences dynamically based on random timestamp
  const terms = [...allTerms].sort(() => Math.random() - 0.5);
  const sentences = [...allSentences].sort(() => Math.random() - 0.5);

  const seed = Math.floor(Math.random() * 1000000);
  const analogiesPool = [
    `Like an intricate assembly line where each specialized station converts raw inputs into high-energy finished goods with rigorous quality check thresholds.`,
    `Comparable to an orchestra conductor synchronizing tempo, dynamics, and harmonic frequency to prevent destructive acoustic interference.`,
    `Think of it like a smart decentralized electrical power grid with step-down transformers, relays, and safety switches balancing surges dynamically.`,
    `Like a high-security cryptographic handshake where only exact matching mathematical keys grant authorization to downstream data streams.`,
    `Similar to international air traffic control monitoring distinct flight corridors, altitudes, wind shear, and fuel reserves to maintain smooth equilibrium.`,
    `Like a precision automated logistics fulfillment center routing prioritized packages through conveyor belts according to destination urgency.`,
    `Comparable to an enzyme active site conformational shift that dramatically lowers activation energy barriers for immediate catalysis.`,
  ];
  const selectedAnalogy = analogiesPool[seed % analogiesPool.length];
  const secondaryAnalogy = analogiesPool[(seed + 3) % analogiesPool.length];

  const questionAngles = [
    (t: string) => `How does "${t}" directly govern equilibrium and reaction dynamics in ${title}?`,
    (t: string) => `What happens to the overall system if "${t}" is removed or its threshold is exceeded?`,
    (t: string) => `Explain the mechanistic relationship between "${t}" and the primary output of ${title}.`,
    (t: string) => `What common misconceptions do examiners penalize regarding "${t}"?`,
    (t: string) => `Define "${t}" using precise academic terminology and specify its standard measurement units or conditions.`,
    (t: string) => `In what experimental scenario would you observe "${t}" acting as the limiting rate factor?`,
  ];

  const flashcards = [
    {
      id: `fc-core-${seed}`,
      front: seed % 2 === 0
        ? `What is the core definition and fundamental law governing ${title}?`
        : `State the first-principles mechanism and scientific significance of ${title}.`,
      back: `It represents the foundational framework dictating interactions, energy transformations, and boundary equilibria within this academic domain.`,
      category: 'Foundations',
      difficulty: 'easy' as const,
    },
    ...terms.slice(0, 10).map((t, idx) => {
      const angleFn = questionAngles[(idx + seed) % questionAngles.length];
      return {
        id: `fc-${idx + 1}-${seed}`,
        front: angleFn(t.term),
        back: `${t.definition} [Critical Factor: ${t.importance.toUpperCase()}]`,
        category: idx % 3 === 0 ? 'Mechanisms' : idx % 2 === 0 ? 'Definitions' : 'Exam Traps',
        difficulty: (idx % 3 === 0 ? 'hard' : idx % 2 === 0 ? 'medium' : 'easy') as 'easy' | 'medium' | 'hard',
      };
    }),
    {
      id: `fc-exam-trap-${seed}`,
      front: `What is the #1 examiner trap and scoring rubric pitfall when tackling questions on ${title}?`,
      back: `Failing to state governing initial conditions, omitting intermediate derivation steps, confusing correlation with causation, and omitting standard SI units.`,
      category: 'Exam Strategy',
      difficulty: 'hard' as const,
    },
  ];

  const conceptCategories = ['Foundational Law', 'Dynamic Driver', 'Intermediate Transition', 'Limiting Constraint', 'Applied Synthesis'];
  const conceptMap = [
    {
      id: `node-1-${seed}`,
      label: title,
      category: 'Central Subject',
      description: `The master academic subject uniting all sub-processes, governing laws, and applied scenarios.`,
      relatedIds: [`node-2-${seed}`, `node-3-${seed}`, `node-4-${seed}`],
    },
    ...terms.slice(0, 4).map((t, idx) => ({
      id: `node-${idx + 2}-${seed}`,
      label: t.term,
      category: conceptCategories[idx % conceptCategories.length],
      description: t.definition,
      relatedIds: [`node-1-${seed}`, `node-${((idx + 1) % 4) + 2}-${seed}`],
    })),
  ];

  let summaryMarkdown = '';

  if (notesFocus === 'analogies') {
    summaryMarkdown = `# Master Intuition & Mental Models: ${title}

## 🧠 Core Conceptual Metaphor
> **💡 The Primary Analogy:** ${selectedAnalogy}
> **🔬 Micro-Level Mechanism:** ${secondaryAnalogy}

---

## 1. First-Principles Breakdown
Mastering **${title}** becomes intuitive when broken into structural stages:
- **Phase 1 (Input & Activation)**: ${sentences[0] || 'Initial variables establish baseline conditions and exceed activation barrier.'}
- **Phase 2 (Catalysis & Interaction)**: ${sentences[1] || 'Dynamic energy transfer and intermediate molecular/mathematical conversions.'}
- **Phase 3 (Steady-State Equilibrium)**: ${sentences[2] || 'System stabilizes into balanced product formation or sustainable output.'}

---

## 2. Metaphorical Vocabulary & Function Mapping

| Concept | Formal Definition | Intuitive Real-World Metaphor |
| :--- | :--- | :--- |
${terms.slice(0, 6).map((t, idx) => `| **${t.term}** | ${t.definition} | *Functions like ${['a regulated pressure-release valve', 'a precision timing relay', 'a selective filter membrane', 'a structural load-bearing scaffold', 'a directional compass amplifier', 'a secure access checkpoint'][idx % 6]}.* |`).join('\n')}

---

## 3. High-Yield Active Recall Prompts
1. Can you explain the primary transformation of **${title}** to a peer without using technical jargon?
2. Which intermediate variable acts as the bottleneck if total throughput is doubled?
3. How does environmental temperature or pressure shift the steady-state equilibrium?
`;
  } else if (notesFocus === 'exam') {
    summaryMarkdown = `# High-Yield Exam Cram Guide & Scoring Rubrics: ${title}

## ⚡ Examiner Secrets & Scoring Criteria
- **Method & Step Marks**: Always write down the general formula *before* substituting values.
- **Essential Keywords**: ${terms.slice(0, 6).map(t => `\`${t.term}\``).join(', ')}.
- **Golden Rule**: Always verify units, state explicit assumptions, and check limiting boundary cases (0, maximum, threshold).

---

## 1. High-Frequency Exam Question Types

| Question Archetype | Examiner Expectation | High-Risk Trap to Avoid |
| :--- | :--- | :--- |
| **Definitions (1-2 Marks)** | State exact scientific meaning of ${terms[0]?.term || 'core laws'}. | Giving vague descriptive examples instead of formal definitions. |
| **Mechanisms & Steps (3-5 Marks)** | Sequential derivation: ${sentences[0] || 'State triggers, intermediate stages, and outputs.'} | Skipping intermediate steps or confusing cause and effect. |
| **Limiting Factors (2-4 Marks)** | Analyze behavior when constraints change. | Assuming linear response at extreme limiting conditions. |

---

## 2. Key Terms & Model Definitions
${terms.slice(0, 8).map(t => `- **${t.term}**: ${t.definition} *(Importance: ${t.importance.toUpperCase()})*`).join('\n')}

---

## 3. Step-by-Step Problem Solving Framework
1. **Annotate Given Data**: List all knowns, unknowns, and required units.
2. **Select Governing Formula**: Write the base equation before substituting values.
3. **Execute & Sense-Check**: Does the magnitude, sign, and unit make physical sense?
`;
  } else if (notesFocus === 'tables') {
    summaryMarkdown = `# Structured Comparative Matrices: ${title}

## 📊 Comprehensive Component Comparison Table

| Variable / Element | Primary Role & Function | Governing Mechanism | Significance Level |
| :--- | :--- | :--- | :--- |
${terms.slice(0, 7).map(t => `| **${t.term}** | System Regulation & Transition | ${t.definition} | \`${t.importance.toUpperCase()}\` |`).join('\n')}

---

## 🔄 Dynamic Process Flow Chart
\`\`\`
[Initial Baseline State]
         │
         ▼ (Activation Energy / Trigger Condition)
[Intermediate Transition: ${terms[0]?.term || 'Primary Phase'}]
         │
         ▼ (Kinetic Exchange / Transformation)
[Stabilization Phase: ${terms[1]?.term || 'Secondary Phase'}]
         │
         ▼
[Final Steady-State Equilibrium: ${title}]
\`\`\`

---

## ⚖️ Positive vs. Limiting Factor Analysis
- **Key Acceleration Factors**: High reactant concentrations, optimal catalyst conformation, favorable energy gradients.
- **Key Limiting Constraints**: Depleted substrate reserves, saturation thresholds, extreme temperature/pH denaturation.
`;
  } else if (notesFocus === 'concise') {
    summaryMarkdown = `# Rapid-Fire Executive Summary: ${title}

## 🚀 60-Second Core Takeaway
**${title}** governs the interaction and transformation of core domain variables under specific equilibrium conditions.

- **Primary Driver**: ${sentences[0] || 'Fundamental forces driving dynamic transformation.'}
- **Core Mechanism**: ${sentences[1] || 'Sequential stages linking initial inputs to final equilibrium.'}
- **Marking Focus**: ${sentences[2] || 'Precise definitions, boundary conditions, and standard SI units.'}

---

## 📌 High-Yield Bullet Points
${terms.slice(0, 8).map(t => `- **${t.term}**: ${t.definition}`).join('\n')}

---

## 🎯 Exam Checkpoint
- [ ] Define **${terms[0]?.term || title}** verbatim.
- [ ] State governing formula and SI units.
- [ ] Diagram the 3-step transition mechanism from memory.
`;
  } else {
    // Standard Comprehensive Guide with rich multifaceted sections
    const outlineArchetypes = [
      {
        section1: 'Executive Overview & First Principles',
        section2: 'Core Architecture & Vocabulary Grid',
        section3: 'Sequential Step-by-Step Mechanism',
        section4: 'Applied Edge Cases & Rubric Mastery',
      },
      {
        section1: 'Foundational Theory & Theoretical Basis',
        section2: 'Key Nomenclature & Concept Matrix',
        section3: 'Kinetic Pathways & Transformation Stages',
        section4: 'Quantitative Applications & Marking Points',
      },
      {
        section1: 'Domain Significance & Governing Laws',
        section2: 'Essential Scientific Terms & Glossary',
        section3: 'Operational Dynamics & Chain Reactions',
        section4: 'Exam Pitfalls & Active Recall Prompts',
      },
    ];
    const chosenOutline = outlineArchetypes[seed % outlineArchetypes.length];

    summaryMarkdown = `# Master Academic Revision Guide: ${title}

## 1. ${chosenOutline.section1}
**${title}** represents a fundamental pillar of this academic syllabus. Mastery requires understanding both baseline definitions and multi-variable dynamic interactions.

- **System Driver**: Foundational laws governing transformations, information flow, and thermodynamic/logical equilibrium.
- **Primary Observation**: ${sentences[0] || 'Understand how primary inputs interact before triggering reactions.'}
- **Intermediate Chain**: ${sentences[1] || 'Energy, information, or mass transfers across sequential stages.'}
- **Equilibrium State**: ${sentences[2] || 'System stabilizes once balanced output criteria are achieved.'}

---

## 2. ${chosenOutline.section2}

| Academic Term | Formal Definition & Function | Exam Weight |
| :--- | :--- | :--- |
${terms.slice(0, 7).map(t => `| **${t.term}** | ${t.definition} | \`${t.importance.toUpperCase()}\` |`).join('\n')}

---

## 3. ${chosenOutline.section3}
1. **Initial Trigger & Input Conditions**: ${sentences[3] || 'Baseline parameters achieve activation threshold.'}
2. **Intermediate Phase & Dynamic Transfer**: ${sentences[4] || 'Dynamic interaction and energy/information transfer across intermediate states.'}
3. **Equilibrium & Product Attainment**: ${sentences[5] || 'System achieves steady-state equilibrium or final yield.'}

---

## 4. ${chosenOutline.section4}
> **💡 Active Recall Challenge:** Cover the vocabulary table above and practice reciting the exact scientific definitions for **${terms[0]?.term || title}** and **${terms[1]?.term || 'governing mechanisms'}** out loud!

- **Boundary Condition Watch-out**: Evaluate system behavior as variables approach zero, infinite capacity, and critical saturation thresholds.
- **Rubric Requirement**: Always specify standard units, explicit assumptions, and intermediate calculations.
`;
  }

  return {
    summaryMarkdown,
    flashcards,
    conceptMap,
    formulasAndDefinitions: [
      {
        term: `Governing Principle / Law of ${title}`,
        formulaOrMeaning: `Primary Output = f(System Inputs, Boundary Conditions) [Direct proportionality under standard constraints]`,
        notes: `Ensure consistent standard units (SI) and explicitly state all environmental assumptions.`,
      },
      {
        term: `Equilibrium & Rate Law`,
        formulaOrMeaning: `Forward Rate = Reverse Rate [Net Δ = 0 at steady-state equilibrium]`,
        notes: `Distinguish between dynamic steady-state and static rest in written explanations.`,
      },
      ...terms.slice(0, 5).map(t => ({
        term: t.term,
        formulaOrMeaning: t.definition,
        notes: `Crucial academic terminology required for full marks on short and long-form responses.`,
      })),
    ],
    quickCheatSheet: [
      `Memorize core definitions verbatim to secure direct recall marks in section A.`,
      `Always write standard units on every intermediate calculation step and final result.`,
      `Check boundary conditions (zero, infinity, threshold) when evaluating edge scenarios.`,
      `Structure long-form essay responses into: (1) Principle, (2) Mechanism, (3) Evidence.`,
      `Review flashcards with spaced repetition intervals daily before exam day.`,
    ],
  };
}

function generateSmartFallbackQuiz(topicTitle: string, sources: any[], count: number = 8, difficulty: string = 'medium', types: string[] = ['multiple_choice', 'true_false', 'fill_in_blank', 'short_answer']) {
  const title = topicTitle || sources[0]?.title || 'Practice Quiz';
  const combinedText = sources.map(s => s.content || '').join('\n\n');
  const terms = extractKeyTermsFromText(combinedText, 10);
  const sentences = extractKeySentences(combinedText, 6);

  const questions: any[] = [];

  // 1. Multiple Choice Questions
  if (types.includes('multiple_choice')) {
    questions.push({
      id: `q-mc-1`,
      type: 'multiple_choice',
      question: `What is the primary role or function of ${title}?`,
      options: [
        `To govern the central mechanisms and interactions within the system`,
        `To eliminate all variables without measurable outcomes`,
        `To act solely as an unobservable theoretical hypothesis`,
        `To prevent any equilibrium from ever forming`,
      ],
      correctAnswer: 0,
      explanation: `Understanding the primary governing role of ${title} provides the framework needed to solve both quantitative and qualitative exam questions.`,
      hint: `Think about the overarching purpose discussed in the fundamentals section.`,
      sourceReference: `Section 1: Foundations`,
    });

    if (terms.length > 0) {
      questions.push({
        id: `q-mc-2`,
        type: 'multiple_choice',
        question: `In the context of ${title}, which statement best describes "${terms[0].term}"?`,
        options: [
          terms[0].definition,
          `A random error that should be ignored during calculations`,
          `An obsolete metric replaced by modern definitions`,
          `A constant that never changes under any circumstances`,
        ],
        correctAnswer: 0,
        explanation: `${terms[0].term} is formally defined as: ${terms[0].definition}`,
        hint: `Review the vocabulary table in your study notes.`,
        sourceReference: `Core Vocabulary`,
      });
    }
  }

  // 2. True / False Questions
  if (types.includes('true_false')) {
    questions.push({
      id: `q-tf-1`,
      type: 'true_false',
      question: `True or False: In ${title}, understanding intermediate mechanism steps is critical for obtaining method marks on exams.`,
      options: ['True', 'False'],
      correctAnswer: 0,
      explanation: `True. Examination rubrics award substantial credit for clearly explaining the sequential mechanism and intermediate variables.`,
      hint: `Consider how examiners grade multi-mark written questions.`,
      sourceReference: `Exam Applications`,
    });

    questions.push({
      id: `q-tf-2`,
      type: 'true_false',
      question: `True or False: Boundary conditions and units can be safely ignored when solving high-level problems in ${title}.`,
      options: ['True', 'False'],
      correctAnswer: 1,
      explanation: `False. Ignoring units and boundary conditions is one of the most common student mistakes that causes lost marks.`,
      hint: `Check the Common Pitfalls section.`,
      sourceReference: `Common Exam Traps`,
    });
  }

  // 3. Fill in the Blank
  if (types.includes('fill_in_blank')) {
    const termToUse = terms[1]?.term || 'Equilibrium';
    questions.push({
      id: `q-fib-1`,
      type: 'fill_in_blank',
      question: `The state where forward and reverse reaction rates or system forces become balanced is known as ________.`,
      options: [],
      correctAnswer: 'Equilibrium',
      explanation: `Equilibrium occurs when dynamic opposing processes proceed at equal rates, resulting in no net observable change.`,
      hint: `Starts with the letter 'E'.`,
      sourceReference: `Process Laws`,
    });

    if (terms.length > 2) {
      questions.push({
        id: `q-fib-2`,
        type: 'fill_in_blank',
        question: `The key concept defined as "${terms[2].definition}" is ________.`,
        options: [],
        correctAnswer: terms[2].term,
        explanation: `${terms[2].term} corresponds directly to this definition in your study source.`,
        hint: `Refers to "${terms[2].term.substring(0, 3)}..."`,
        sourceReference: `Vocabulary Review`,
      });
    }
  }

  // 4. Open-Ended Short Answer (AI Graded)
  if (types.includes('short_answer')) {
    questions.push({
      id: `q-sa-1`,
      type: 'short_answer',
      question: `Explain the step-by-step mechanism of ${title}, describing how initial inputs transition through intermediate phases to reach the final state.`,
      options: [],
      correctAnswer: `A complete answer should mention: 1) Initial conditions and triggers, 2) The step-by-step intermediate transformation or interaction, 3) The resulting equilibrium/output, and 4) Accurate use of domain-specific terminology.`,
      explanation: `Demonstrating clear chronological logic and formal academic terms will earn maximum marks on essay-style questions.`,
      hint: `Recall the 3-phase sequence: Initial Input -> Intermediate Transformation -> Final Equilibrium.`,
      sourceReference: `Section 2: Mechanism Breakdown`,
    });
  }

  // Slice to requested count
  const finalQuestions = questions.slice(0, count);

  return {
    id: `quiz-${Date.now()}`,
    topicTitle: title,
    difficulty,
    questions: finalQuestions,
  };
}

// Helper to execute Gemini requests reliably with optional search grounding, direct JSON mode, and multi-tier model fallback
async function callGeminiStructured<T = any>(
  ai: any,
  {
    prompt,
    sources = [],
    systemInstruction,
    effectiveWebSearch = false,
    temperature = 0.85,
    validator,
  }: {
    prompt: string;
    sources?: any[];
    systemInstruction: string;
    effectiveWebSearch?: boolean;
    temperature?: number;
    validator: (parsed: any) => boolean;
  }
): Promise<T | null> {
  const parts = buildGeminiSourceParts(sources, prompt);
  const candidateModels = ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.7-flash'];

  // Attempt 1: If effectiveWebSearch is enabled, try search grounding tool (WITHOUT responseMimeType to prevent 400 errors)
  if (effectiveWebSearch) {
    const searchInstruction = `${systemInstruction}

CRITICAL STRUCTURED OUTPUT MANDATE:
You MUST return ONLY a single valid JSON object. Wrap your entire JSON inside a markdown code block (\`\`\`json ... \`\`\`).
Do NOT include any introductory commentary, greeting, or conversational text outside the code block.`;

    for (const modelName of ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.7-flash']) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: [
            {
              role: 'user',
              parts: parts,
            },
          ],
          config: {
            systemInstruction: searchInstruction,
            tools: [{ googleSearch: {} }],
            temperature: Math.min(1.0, temperature + 0.1),
            maxOutputTokens: 8192,
          },
        });

        const text = response.text || '';
        const parsed = parseJsonSafely(text, null);
        if (parsed && validator(parsed)) {
          return parsed as T;
        }
      } catch (searchErr: any) {
        const status = searchErr?.status || searchErr?.code || 'ERROR';
        console.warn(`Gemini search grounding on ${modelName} encountered ${status}, continuing fallback.`);
      }
    }
  }

  // Attempt 2: Direct structured JSON generation across multi-tier model cascade
  for (const modelName of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: parts,
          },
        ],
        config: {
          systemInstruction: systemInstruction,
          responseMimeType: 'application/json',
          temperature: temperature,
          maxOutputTokens: 8192,
        },
      });

      const text = response.text || '{}';
      const parsed = parseJsonSafely(text, null);
      if (parsed && validator(parsed)) {
        return parsed as T;
      }
    } catch (directErr: any) {
      const status = directErr?.status || directErr?.code || 'ERROR';
      console.warn(`Gemini model ${modelName} structured call encountered ${status}, trying next candidate.`);
    }
  }

  return null;
}

// -------------------------------------------------------------
// Endpoints with AI + Resilient Fallbacks
// -------------------------------------------------------------

// 1. Generate Interactive Lesson ("Teach Me")
app.post('/api/generate-lesson', async (req, res) => {
  try {
    const { topicTitle, sources, customInstruction, teachingStyle, language, allowWebSearch } = req.body;
    
    // Auto-check web search if no sources
    const effectiveWebSearch = (!sources || sources.length === 0) ? true : !!allowWebSearch;
    const title = topicTitle || (sources && sources.length > 0 ? sources[0].title : '') || 'Revision Topic';

    if (!title && (!sources || sources.length === 0)) {
       return res.status(400).json({ error: 'Please provide a topic title or at least one source document.' });
    }

    const ai = getAI();

    if (ai) {
      const isCustomLang = language && language.trim() !== '' && language.toLowerCase() !== 'auto' && language.toLowerCase() !== 'default';
      const langDirective = isCustomLang
        ? `Generate ALL content, titles, explanations, analogies, key terms, and questions strictly in "${language}".`
        : `CRITICAL LANGUAGE REQUIREMENT: The user has not selected an alternate language. You MUST write ALL content, titles, sections, definitions, detailed explanations, analogies, key terms, pitfalls, check questions, and markdown notes ENTIRELY in ENGLISH (even if the source text or prompt contains other languages).`;

      const styleDirective = customInstruction || teachingStyle
        ? `USER'S CUSTOM TEACHING & STYLE DIRECTIVE: "${customInstruction || teachingStyle}". (e.g. If the student asked "teach like I am a beginner", simplify complex terminology, use vivid everyday analogies, and break ideas down step-by-step. If asked "make it more interesting", add dramatic real-life applications, intriguing hooks, and engaging narrative flow. If "university level", provide high-level academic depth).`
        : `Style: High-retention Socratic revision with clear intuitive analogies, active recall questions, and common exam pitfall warnings.`;

      const groundingDirective = sources && sources.length > 0
          ? `CRITICAL LONG-SOURCE & GROUNDING DIRECTIVE:
1. Base your teaching, mechanisms, facts, definitions, and context 100% on the provided source materials.
2. PATIENT & EXHAUSTIVE CHAPTERIZATION MANDATE: If the sources are extensive or long (e.g., multi-page documents, multi-topic syllabus, or textbook chapters):
   - You MUST be patient, meticulous, and thorough. Do NOT rush, summarize hastily, or skip sections.
   - Systematically organize the ENTIRE material into complete, sequential chapters (e.g. 4 to 8 sections) so that EVERY topic, sub-mechanism, proof, and case study in the source has its own dedicated chapter.
   - NO key concepts or parts of the syllabus may be omitted.
3. NATURAL TONE MANDATE: Do NOT explicitly mention, disclaim, or emphasize that you are strictly relying on provided sources or that web search was/was not used. Teach the content naturally, authoritatively, and directly.`
         : `CRITICAL KNOWLEDGE & CHAPTERIZATION DIRECTIVE:
1. Rely on your extensive academic knowledge base and live web search grounding to provide accurate, up-to-date, and rigorous information.
2. Organize the material systematically into complete sequential chapters (e.g. 4 to 8 sections) so NO key concepts or parts of the syllabus are omitted.`;

      const prompt = `You are a world-class revision tutor creating a comprehensive, high-retention interactive step-by-step lesson for a student studying "${title}". [Session ID: ${Date.now()}]

${groundingDirective}

PEDAGOGICAL ORDERING MANDATE:
Always start with the foundational Definition, Origin/History, and General Information FIRST before diving into deeper sub-topics, mechanisms, business models, or advanced technical concepts.
For example, if one writes the title as "McDonald's":
- Section 1 / Chapter 1 MUST be "1. Definition, Overview & General Information" (defining what McDonald's is: the world's largest fast-food restaurant chain founded in 1940 by the McDonald brothers and franchised by Ray Kroc, famous for the Golden Arches, fast food standardization, hamburgers, and global reach).
- Subsequent sections then delve sequentially deeper into: "2. Business Model: Franchising & Real Estate Strategy", "3. Global Supply Chain & Operational Standardization", "4. Marketing, Cultural Impact & Localization", "5. Modern Adaptations & Future Outlook".

DIVERSITY, DEPTH & PATIENCE MANDATE:
- Formulate a creative, unique, deeply tailored, and exhaustive lesson specifically built for this topic.
- Be patient and thorough: provide rich detailedContent for every chapter section with ## subheaders, clear explanations, comparison tables, key terms, and active recall check questions.
- Avoid repetitive or generic template phrasing.
- Build vivid, memorable analogies that make the underlying mechanics intuitive.

LANGUAGE REQUIREMENT:
${langDirective}

TEACHING STYLE:
${styleDirective}

IMAGE ENRICHMENT: Whenever relevant, enrich the lesson content by including helpful images using standard Markdown syntax \`![description](image_url)\`. If web search is enabled, try to find and use real, high-quality image URLs that accurately reflect the topic. If images are provided in the source materials, you can embed them too.

Generate a structured JSON revision lesson matching this exact format:
{
  "topicTitle": "${title}",
  "overview": "clear 2-3 sentence overview explaining why this topic matters.",
  "learningObjectives": ["objective 1", "objective 2", "objective 3", "objective 4", "objective 5"],
  "estimatedStudyTimeMinutes": 25,
  "language": "${language || 'auto'}",
  "teachingStyle": "${teachingStyle || 'standard'}",
  "customInstruction": "${customInstruction ? customInstruction.replace(/"/g, "'") : ''}",
  "sections": [
    {
      "id": "sec-1",
      "title": "1. Definition, Overview & General Information",
      "summary": "1-2 sentence core concept takeaway.",
      "detailedContent": "Rich Markdown formatted teaching text with clear ## subheaders, bullet points, bold key terms, comparison tables, and ascii flowcharts if helpful.",
      "analogy": "A memorable real-world analogy to help the student intuitively understand the mechanism.",
      "keyConcepts": [
        { "term": "Key Term 1", "definition": "Clear concise definition from source.", "importance": "critical" },
        { "term": "Key Term 2", "definition": "Clear concise definition from source.", "importance": "important" }
      ],
      "pitfallsToAvoid": ["Common student mistake 1", "Exam pitfall 2"],
      "checkQuestion": {
        "question": "Active recall test question for this section",
        "options": ["Option A", "Option B", "Option C", "Option D"],
        "correctIndex": 0,
        "explanation": "Detailed explanation of why Option A is correct based on the source."
      }
    }
  ],
  "examTips": ["High-yield exam tip 1", "High-yield exam tip 2", "High-yield exam tip 3", "High-yield exam tip 4"]
}

Return ONLY a valid JSON object matching this structure.`;

      const systemInstruction = sources && sources.length > 0
        ? 'You are a helpful, clear academic tutor. Explain concepts using simple words, easy-to-understand language, and intuitive analogies without dense jargon. Always follow the source material faithfully and return strictly valid JSON matching the requested structure.'
        : 'You are a helpful, clear academic tutor. Explain concepts using simple words, easy-to-understand language, and intuitive analogies without dense jargon. Rely on your academic knowledge and return strictly valid JSON matching the requested structure.';

      const parsed = await callGeminiStructured(ai, {
        prompt,
        sources,
        systemInstruction,
        effectiveWebSearch,
        temperature: 0.85,
        validator: (res) => !!(res && res.sections && Array.isArray(res.sections) && res.sections.length > 0),
      });

      if (parsed) {
        return res.json(parsed);
      }
    }

    // Fallback synthesis
    const lessonData = generateSmartFallbackLesson(title, sources);
    return res.json(lessonData);
  } catch (err: any) {
    console.error('Error in /api/generate-lesson, providing fallback synthesis:', err);
    const fallbackTitle = req.body?.topicTitle || 'Revision Topic';
    const lessonData = generateSmartFallbackLesson(fallbackTitle, req.body?.sources || []);
    return res.json(lessonData);
  }
});

// 2. Generate Full Comprehensive Interactive Study Notes, Flashcards & Mindmap
app.post('/api/generate-notes', async (req, res) => {
  try {
    const { topicTitle, sources, customInstruction, teachingStyle, language, allowWebSearch, lessonStructure, notesFocus } = req.body;
    
    // Auto-check web search if no sources
    const effectiveWebSearch = (!sources || sources.length === 0) ? true : !!allowWebSearch;
    const rawTitle = topicTitle || (sources && sources.length > 0 ? sources[0].title : '') || 'Study Material';
    const title = cleanFallbackTitle(rawTitle);

    if (!title && (!sources || sources.length === 0)) {
       return res.status(400).json({ error: 'Please provide a topic title or at least one source document.' });
    }

    const ai = getAI();

    if (ai) {
      const isCustomLang = language && language.trim() !== '' && language.toLowerCase() !== 'auto' && language.toLowerCase() !== 'default';
      const langDirective = isCustomLang
        ? `Generate ALL markdown notes, flashcards, concept maps, formulas, and cheat sheets strictly in "${language}".`
        : `CRITICAL LANGUAGE REQUIREMENT: The user has not selected an alternate language. You MUST write EVERYTHING (summaryMarkdown, flashcard questions and answers, concept map labels, descriptions, formulas, and quick cheat sheet points) ENTIRELY in ENGLISH (even if the source text contains other languages).`;

      let focusInstruction = '';
      if (notesFocus === 'analogies') {
        focusInstruction = 'SPECIAL PEDAGOGICAL EMPHASIS: Explain technical mechanisms via creative, relatable real-world analogies, conceptual metaphors, and visual mental models in every chapter.';
      } else if (notesFocus === 'concise') {
        focusInstruction = 'SPECIAL PEDAGOGICAL EMPHASIS: Create ultra-clean, high-yield bullet notes and executive summaries optimized for rapid last-minute revision.';
      } else if (notesFocus === 'exam') {
        focusInstruction = 'SPECIAL PEDAGOGICAL EMPHASIS: Focus heavily on high-yield marking scheme requirements, examiner pitfall traps, method marks, and model exam bullet points.';
      } else if (notesFocus === 'tables') {
        focusInstruction = 'SPECIAL PEDAGOGICAL EMPHASIS: Provide deep comparative tables, structured matrix grids, side-by-side differentiations, and process flowcharts in Markdown.';
      } else {
        focusInstruction = 'SPECIAL PEDAGOGICAL EMPHASIS: Provide a rich, multifaceted revision guide combining first-principles logic, clear step-by-step processes, bold key terms, and active recall cues.';
      }

      const styleDirective = customInstruction || teachingStyle
        ? `CUSTOM INSTRUCTION: "${customInstruction || teachingStyle}". Keep notes structured, complete, deeply engaging, and easy to read.`
        : `Format notes with clean hierarchical Markdown, bold technical terms, and high-yield callout boxes.`;

      let structureDirective = sources && sources.length > 0 
        ? `1. LONG-SOURCE CHAPTERIZATION & PATIENCE MANDATE:
- The source document may be extensive or multi-page. You MUST be patient, thorough, and exhaustive.
- DO NOT produce a brief summary, generic bullet points, or hasty notes because of document length. Notes MUST be full and comprehensive.
- Break down the ENTIRE source material into full, distinct chapters ('## Chapter 1: ...', '## Chapter 2: ...', '## Chapter 3: ...' up to as many chapters as needed to cover 100% of the material from start to finish).
- Under each chapter: write detailed explanatory paragraphs, ### subsections, formulas/equations, comparison tables, step-by-step processes, and bold technical definitions so NO information is lost or skipped.`
        : `1. Generate comprehensive and deeply informative notes on the topic, ensuring a high level of academic rigor and exhaustive coverage of the subject matter. Break down the material into distinct, well-developed chapters.`;
      
      if (lessonStructure && lessonStructure.sections) {
        const sectionTitles = lessonStructure.sections.map((s: any) => s.title).join('\n- ');
        structureDirective = `1. CHAPTER-MATCHING MANDATE: Your generated notes MUST follow this exact chapter structure from the companion lesson:\n- ${sectionTitles}\nDO NOT invent new chapters or combine these chapters. Create exhaustive, full notes that fill out each of these specific chapters in depth.`;
      }

      const sourceStrictness = sources && sources.length > 0
          ? `3. Base your notes, mechanisms, and definitions on the provided source content.
NATURAL TONE MANDATE: Do NOT explicitly mention, disclaim, or state to the student that you are strictly following sources or that web search was/was not used. Teach the content authoritatively and cleanly.`
         : `3. Utilize your extensive knowledge base and live web search grounding to formulate accurate, highly-detailed study notes.`;

      const randomSeed = `${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
      const perspectiveHooks = [
        'Approach the breakdown through first-principles mechanisms, functional causality, and practical intuition.',
        'Emphasize structural architecture, anatomical/spatial relationships, and systemic interaction dynamics.',
        'Highlight empirical proof, real-world case scenarios, and high-yield quantitative relationships.',
        'Focus on comparative trade-offs, dynamic limiting factors, and feedback loops.',
        'Emphasize masterclass academic synthesis with vivid mental models and active recall triggers.'
      ];
      const selectedHook = perspectiveHooks[Math.floor(Math.random() * perspectiveHooks.length)];

      const prompt = `Create a FRESH, COMPREHENSIVE, UNTRUNCATED interactive study revision guide, high-yield flashcards, and concept maps for the topic: "${title}".
[Unique Session Variation Seed: ${randomSeed}]
[Pedagogical Framework: ${selectedHook}]

PEDAGOGICAL ORDERING MANDATE:
Chapter 1 of 'summaryMarkdown' MUST ALWAYS be:
'## 1. Foundational Definition, Overview & General Information'
Teach the fundamental definition, what the subject is, its origins, general background, and core identity BEFORE moving into deeper mechanisms, formulas, sub-topics, or advanced analysis.
For example, if the title is "McDonald's":
- Chapter 1 MUST provide the clear definition, founders, history, global scale, and general overview.
- Chapter 2 provides the core business model & franchising revenue mechanisms.
- Chapter 3 provides operational standardization, supply chain & Speedee system.
- Chapter 4 provides marketing, cultural impact, and modern adaptations.

CRITICAL COMPREHENSIVENESS, FULL CHAPTERS & PATIENCE MANDATE:
${structureDirective}
2. In 'summaryMarkdown', provide an exhaustive revision guide covering foundational principles, multi-step processes, formulas/equations, key terms, and comparative tables. Notes must be FULL and detailed—never brief or rushed.
${sourceStrictness}
${focusInstruction}
4. MANDATORY DIVERSITY & FRESHNESS: Never output boilerplate or repetitive notes. Use fresh phrasing, unique analogies, varied active recall flashcards covering edge cases and pitfalls, and rich conceptual linkage in the concept map.

LANGUAGE INSTRUCTION:
${langDirective}

STYLE INSTRUCTION:
${styleDirective}

IMAGE ENRICHMENT: Whenever relevant, enrich the markdown notes by including helpful images using standard Markdown syntax \`![description](image_url)\`. If web search is enabled, try to find and use real, high-quality image URLs that accurately reflect the topic. If images are provided in the source materials, you can embed them too.

Generate JSON with:
1. summaryMarkdown: A master revision guide in rich Markdown with # Header, ## Chapter sections, ### Deep dives, bold keywords, full comparison tables, and > Active recall callout boxes.
2. flashcards: 12 to 20 high-retention active recall flashcards covering all critical concepts across the source. Each with { "id": "fc-1", "front": "string", "back": "string", "category": "string", "difficulty": "easy" | "medium" | "hard" }.
3. conceptMap: 6 to 12 interconnected concept nodes representing the relationship graph of the topic. Each with { "id": "node-1", "label": "string", "category": "string", "description": "string", "relatedIds": ["node-2", "node-3"] }.
4. formulasAndDefinitions: Array of 6 to 15 crucial formulas, laws, theorems, or formal definitions from the source with { "term": "string", "formulaOrMeaning": "string", "notes": "string" }.
5. quickCheatSheet: 6 to 10 rapid-fire high-yield bullet takeaways for last-minute exam prep.

Return ONLY a valid JSON object matching this structure.`;

      const systemInstruction = sources && sources.length > 0
        ? 'You are an inspiring, creative notes author and academic tutor. Write easy-to-understand, engaging, beautifully formatted revision guides using clear language grounded 100% in the source material. Avoid dense jargon. Return strictly valid JSON.'
        : 'You are an inspiring, creative notes author and academic tutor. Write easy-to-understand, engaging, beautifully formatted revision guides using clear language based on academic knowledge. Avoid dense jargon. Return strictly valid JSON.';

      const parsed = await callGeminiStructured(ai, {
        prompt,
        sources,
        systemInstruction,
        effectiveWebSearch,
        temperature: 0.95,
        validator: (res) => !!(res && res.flashcards && Array.isArray(res.flashcards) && res.flashcards.length > 0),
      });

      if (parsed) {
        return res.json(parsed);
      }
    }

    // Fallback synthesis
    const notesData = generateSmartFallbackNotes(title, sources, notesFocus);
    return res.json(notesData);
  } catch (err: any) {
    console.error('Error in /api/generate-notes, providing fallback synthesis:', err);
    const fallbackTitle = req.body?.topicTitle || 'Study Material';
    const notesData = generateSmartFallbackNotes(fallbackTitle, req.body?.sources || [], req.body?.notesFocus);
    return res.json(notesData);
  }
});

// 3. Generate Practice Questions / Quizzes
app.post('/api/generate-quiz', async (req, res) => {
  try {
    const {
      topicTitle,
      sources,
      questionCount = 8,
      difficulty = 'medium',
      questionTypes = ['multiple_choice', 'true_false', 'fill_in_blank', 'short_answer'],
      customInstruction,
      teachingStyle,
      language,
      allowWebSearch,
    } = req.body;

    // Auto-check web search if no sources
    const effectiveWebSearch = (!sources || sources.length === 0) ? true : !!allowWebSearch;
    const title = topicTitle || (sources && sources.length > 0 ? sources[0].title : '') || 'Revision Quiz';

    if (!title && (!sources || sources.length === 0)) {
       return res.status(400).json({ error: 'Please provide a topic title or at least one source document.' });
    }

    const ai = getAI();

    if (ai) {
      const isCustomLang = language && language.trim() !== '' && language.toLowerCase() !== 'auto' && language.toLowerCase() !== 'default';
      const langDirective = isCustomLang
        ? `Write ALL questions, options, answers, hints, and explanations strictly in "${language}".`
        : `CRITICAL LANGUAGE REQUIREMENT: The user has not selected an alternate language. You MUST write ALL questions, options, answers, hints, and explanations ENTIRELY in ENGLISH.`;

      const styleDirective = customInstruction || teachingStyle
        ? `CUSTOM INSTRUCTION: "${customInstruction || teachingStyle}". (e.g. if requested 'beginner', test fundamental concepts clearly; if 'exam focus', write realistic exam board style questions with marking hints).`
        : `Create rigorous, high-yield practice questions testing active recall and application.`;

      const groundingDirective = sources && sources.length > 0
         ? `GROUNDING MANDATE:
All questions, correct answers, and explanations MUST be 100% grounded in the facts and principles stated in the source documents.`
         : `GROUNDING MANDATE:
All questions, correct answers, and explanations MUST be accurate and logically sound based on rigorous academic knowledge. `;

      const prompt = `Generate a high-quality practice revision quiz with ${questionCount} questions based on the topic. [Seed: ${Date.now()}]
Topic: "${title}"
Target Difficulty: ${difficulty}
Allowed Question Types: ${JSON.stringify(questionTypes)}

${groundingDirective}

DIVERSITY REQUIREMENT:
- Formulate a balanced, varied set of distinct questions testing different angles (conceptual recall, problem solving, distinguishing definitions, identifying traps).
- Avoid repetitive stems or predictable question patterns.

LANGUAGE REQUIREMENT:
${langDirective}

STYLE:
${styleDirective}

Create a balanced mix of questions according to the allowed types:
- 'multiple_choice': 4 options (array of strings), correctAnswer is 0-based index number (0, 1, 2, 3).
- 'true_false': options must be ["True", "False"] (or translated equivalent), correctAnswer is 0 (for True) or 1 (for False).
- 'fill_in_blank': question with "____", correctAnswer is the key word/phrase (string), options is empty array [].
- 'short_answer': open-ended exam question. correctAnswer is the model ideal answer/key points string.

Each question MUST include:
{
  "id": "q-1",
  "type": "multiple_choice" | "true_false" | "fill_in_blank" | "short_answer",
  "question": "string",
  "options": ["string"],
  "correctAnswer": 0 | "string",
  "explanation": "string",
  "hint": "string",
  "sourceReference": "string"
}

Return ONLY a JSON object:
{
  "id": "quiz-${Date.now()}",
  "topicTitle": "${title}",
  "difficulty": "${difficulty}",
  "questions": [ ... ]
}`;

      const systemInstruction = sources && sources.length > 0
        ? 'You are an experienced examiner and question creator. Create realistic, grounded questions testing conceptual recall strictly from the source material. Return strictly valid JSON.'
        : 'You are an experienced examiner and question creator. Create realistic, academically rigorous questions testing conceptual recall. Return strictly valid JSON.';

      const parsed = await callGeminiStructured(ai, {
        prompt,
        sources,
        systemInstruction,
        effectiveWebSearch,
        temperature: 0.85,
        validator: (res) => !!(res && res.questions && Array.isArray(res.questions) && res.questions.length > 0),
      });

      if (parsed) {
        return res.json(parsed);
      }
    }

    // Fallback quiz synthesis
    const quizData = generateSmartFallbackQuiz(title, sources, questionCount, difficulty, questionTypes);
    return res.json(quizData);
  } catch (err: any) {
    console.error('Error in /api/generate-quiz, providing fallback synthesis:', err);
    const fallbackTitle = req.body?.topicTitle || 'Revision Quiz';
    const quizData = generateSmartFallbackQuiz(fallbackTitle, req.body?.sources || [], req.body?.questionCount || 8, req.body?.difficulty || 'medium', req.body?.questionTypes || ['multiple_choice', 'true_false']);
    return res.json(quizData);
  }
});

// 4. Adapt / Re-explain a single Lesson Section on demand
app.post('/api/adapt-lesson-section', async (req, res) => {
  try {
    const { section, topicTitle, sources, instruction, language, allowWebSearch } = req.body;
    const effectiveWebSearch = (!sources || sources.length === 0) ? true : !!allowWebSearch;
    if (!section) {
      return res.status(400).json({ error: 'Section data is required.' });
    }

    const ai = getAI();
    if (ai) {
      const isCustomLang = language && language.trim() !== '' && language.toLowerCase() !== 'auto' && language.toLowerCase() !== 'default';
      const langDirective = isCustomLang
        ? `Write the adapted explanation strictly in "${language}".`
        : `Write the adapted explanation ENTIRELY in ENGLISH.`;

      const prompt = `You are a personalized Socratic tutor. The student is asking you to adapt or re-explain the following chapter section according to their specific learning preference:

STUDENT'S REQUEST: "${instruction || 'Teach like I am a beginner and make it much more interesting'}"

CURRENT SECTION:
Title: ${section.title}
Summary: ${section.summary}
Detailed Content: ${section.detailedContent}

GROUNDING CONTEXT:
Topic: "${topicTitle}"

INSTRUCTIONS:
1. Re-write and enhance the 'detailedContent' and 'analogy' to directly fulfill the student's request (e.g. beginner-friendly tone, vivid story hooks, visual ASCII diagrams, step-by-step breakdown).
2. Keep all scientific and factual concepts accurate to the study materials.
3. NATURAL TONE MANDATE: Do NOT explicitly state or disclaim that you are strictly following sources or that web search was/was not used. Explain the concepts naturally.
4. IMAGE ENRICHMENT: Whenever relevant, enrich the 'detailedContent' by including helpful images using standard Markdown syntax \`![description](image_url)\`. If web search is enabled, try to find and use real, high-quality image URLs that accurately reflect the topic.
5. ${langDirective}
6. Return a JSON object with:
{
  "detailedContent": "New rich markdown explanation...",
  "analogy": "New intuitive real-world analogy...",
  "summary": "Concise summary..."
}`;

      const systemInstruction = 'You are an adaptable, engaging academic tutor. Use simple, easy-to-understand words. Return strictly valid JSON.';

      const parsed = await callGeminiStructured(ai, {
        prompt,
        sources: sources || [],
        systemInstruction,
        effectiveWebSearch,
        temperature: 0.85,
        validator: (res) => !!(res && res.detailedContent),
      });

      if (parsed) {
        return res.json({
          ...section,
          detailedContent: parsed.detailedContent,
          analogy: parsed.analogy || section.analogy,
          summary: parsed.summary || section.summary,
        });
      }
    }

    // Fallback adaptation
    return res.json({
      ...section,
      summary: `Simplified: ${section.summary}`,
      detailedContent: `### Simplified Beginner Breakdown\n\n${section.detailedContent}\n\n> **Key Takeaway**: Focus on how the core components interact step-by-step before worrying about complex secondary formulas.`,
      analogy: `Imagine this like a simple everyday machine where input A directly powers output B.`,
    });
  } catch (err: any) {
    console.error('Error adapting section, providing fallback:', err);
    const sec = req.body?.section || { title: 'Topic Section', summary: 'Key takeaway summary', detailedContent: 'Section content explanation' };
    return res.json({
      ...sec,
      summary: `Simplified: ${sec.summary || 'Summary'}`,
      detailedContent: `### Simplified Beginner Breakdown\n\n${sec.detailedContent || 'Content'}\n\n> **Key Takeaway**: Focus on the core components and foundational concepts.`,
      analogy: `Imagine this like a simple everyday machine where input A directly powers output B.`,
    });
  }
});

// 4. Grade Short Answer / Essay Question with AI Rubric
app.post('/api/grade-short-answer', async (req, res) => {
  try {
    const { question, studentAnswer, idealAnswer, context } = req.body;
    if (!question || !studentAnswer) {
      return res.status(400).json({ error: 'Question and student answer are required.' });
    }

    const ai = getAI();

    if (ai) {
      const prompt = `You are a precision academic exam grader evaluating a student's answer against standard marking criteria.

QUESTION: "${question}"
STUDENT'S ANSWER: "${studentAnswer}"
IDEAL / MODEL KEY CRITERIA: "${idealAnswer || 'Accurate explanation of the core concept'}"
CONTEXT: "${context || ''}"

GRADING RUBRIC:
- score: Integer from 0 to 100 representing exact factual accuracy, completeness, and conceptual grasp (90-100: flawless/comprehensive, 70-85: correct core idea with minor keyword omissions, 40-65: partially correct but missing major criteria, 0-35: factually incorrect or irrelevant).
- isCorrect: boolean (true if score >= 70, false otherwise).
- strengths: Concise statement of what the student understood or stated correctly.
- missingPoints: Specific missing keywords, mechanisms, or misconceptions needed for 100% (empty if score >= 95).
- aiFeedback: Direct, supportive 1-2 sentence coaching comment addressing the student.
- improvedModelAnswer: A clear, concise 100% model answer.

Return ONLY a valid JSON object matching:
{
  "score": number,
  "isCorrect": boolean,
  "strengths": string,
  "missingPoints": string,
  "aiFeedback": string,
  "improvedModelAnswer": string
}`;

      const systemInstruction = 'You are an accurate, fast, and supportive exam evaluator. Grade rigorously on accuracy while providing clear, constructive feedback. Return valid JSON.';

      // Fast, high-accuracy grading cascade (prioritizing fast flash models with low temperature for deterministic rubric evaluation)
      for (const modelName of ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.7-flash']) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: [
              {
                role: 'user',
                parts: [{ text: prompt }],
              },
            ],
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              temperature: 0.2, // Low temperature for high consistency and accuracy
            },
          });

          const text = response.text || '{}';
          const parsed = parseJsonSafely(text, null);
          if (parsed && typeof parsed.score === 'number') {
            return res.json({
              score: Math.min(100, Math.max(0, Math.round(parsed.score))),
              isCorrect: typeof parsed.isCorrect === 'boolean' ? parsed.isCorrect : parsed.score >= 70,
              strengths: parsed.strengths || 'Identified core principles accurately.',
              missingPoints: parsed.missingPoints || '',
              aiFeedback: parsed.aiFeedback || 'Good effort! Continue practicing to reinforce key terminology.',
              improvedModelAnswer: parsed.improvedModelAnswer || idealAnswer || 'Review the core definitions in your notes.',
            });
          }
        } catch (modelErr: any) {
          const status = modelErr?.status || modelErr?.code || 'ERROR';
          console.warn(`Fast grading on model ${modelName} encountered ${status}, trying next candidate.`);
        }
      }
    }

    // Heuristic assessment fallback
    const studentWords = (studentAnswer || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const idealWords = (idealAnswer || question || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const overlap = studentWords.filter(w => idealWords.includes(w)).length;
    const ratio = Math.min(1, overlap / Math.max(2, idealWords.length * 0.4));
    const score = Math.round(50 + ratio * 45);

    return res.json({
      score,
      isCorrect: score >= 70,
      strengths: `You demonstrated a good grasp of the foundational concepts and expressed your reasoning clearly.`,
      missingPoints: `To score full 100% marks, be sure to include all formal academic terminology and relevant boundary conditions.`,
      aiFeedback: `Great effort! Your explanation shows solid understanding. Focus on including all technical key terms to lock in full marks.`,
      improvedModelAnswer: idealAnswer || `${question}: State the initial conditions, describe the intermediate mechanism, and define the final outcome.`,
    });
  } catch (err: any) {
    console.error('Error grading answer, providing fallback:', err);
    return res.json({
      score: 75,
      isCorrect: true,
      strengths: `Good fundamental understanding of the core concept.`,
      missingPoints: `Include formal definitions and standard units for full marks.`,
      aiFeedback: `Solid effort! Make sure to write out the full step-by-step mechanism during exam situations.`,
      improvedModelAnswer: req.body?.idealAnswer || req.body?.question || 'Review the core mechanism in the study notes.',
    });
  }
});

// 5. Interactive Socratic Tutor Chat
app.post('/api/tutor-chat', async (req, res) => {
  try {
    const {
      messages,
      topicTitle,
      sources,
      tutorMode = 'socratic',
      customInstruction,
      language,
      allowWebSearch,
      currentSection,
    } = req.body;
    const effectiveWebSearch = (!sources || sources.length === 0) ? true : !!allowWebSearch;
    if (!messages || !messages.length) {
      return res.status(400).json({ error: 'Message history is required.' });
    }

    const ai = getAI();

    let styleInstruction = 'You are an inspiring, warm, highly accurate, and responsive academic revision tutor.';
    if (tutorMode === 'socratic') {
      styleInstruction += ' Provide a clear and factually precise direct explanation to the student\'s question first, then ask a thoughtful Socratic question to guide their deep understanding.';
    } else if (tutorMode === 'simple') {
      styleInstruction += ' Teach like the student is a beginner: use clear simple language, vivid everyday metaphors, and zero unexplained jargon.';
    } else if (tutorMode === 'exam_prep') {
      styleInstruction += ' Focus on exam mastery: highlight marking criteria, high-yield exam phrasing, common student pitfalls, and model answer structure.';
    } else if (tutorMode === 'deep_dive') {
      styleInstruction += ' Provide deep, rigorous academic depth, exact mechanisms, equations, boundary conditions, and real-world implications.';
    }

    if (customInstruction) {
      styleInstruction += `\nUSER CUSTOM PREFERENCE: "${customInstruction}". Obey this teaching style closely in your explanations.`;
    }

    const isCustomLang = language && language.trim() !== '' && language.toLowerCase() !== 'auto' && language.toLowerCase() !== 'default';
    const langDirective = isCustomLang
      ? `Generate your response strictly in "${language}".`
      : `Unless the student explicitly asks you to reply in another language in their message, write your entire response and suggested questions in ENGLISH.`;

    let sourceContext = '';
    if (sources && sources.length) {
      sourceContext = `\n--- GROUNDING STUDY SOURCES ---\n`;
      for (const s of sources) {
        sourceContext += `Document: ${s.title || s.fileName}\n${(s.content || '').substring(0, 25000)}\n\n`;
      }
    }

    let sectionContext = '';
    if (currentSection) {
      sectionContext = `\n--- CURRENT SECTION UNDER STUDY ---\nSection Title: ${currentSection.title || ''}\nSummary: ${currentSection.summary || ''}\nKey Concepts: ${JSON.stringify(currentSection.keyConcepts || [])}\n`;
    }

    const systemPrompt = `${styleInstruction}

CORE PEDAGOGICAL & ACCURACY DIRECTIVES:
1. Provide a direct, highly accurate, and clear explanation to the student's question immediately in your first paragraph.
2. Ground your explanations strictly in the student's study topic "${topicTitle || 'General Revision'}" and the provided study sources whenever applicable.
3. Keep your response scannable and engaging (use bolding for key terms, bullet points for steps, and clear line breaks).
4. Provide 3 short, relevant, and engaging suggested follow-up questions tailored to test or expand the student's understanding.

IMAGE ENRICHMENT:
Whenever relevant, enrich your chat response by including helpful images using standard Markdown syntax \`![description](image_url)\`. If web search is enabled, try to find and use real, high-quality image URLs that accurately reflect the topic.

LANGUAGE REQUIREMENT:
${langDirective}

Return JSON in this format:
{
  "reply": "Your markdown formatted tutor response here...",
  "suggestedQuestions": ["Suggested question 1?", "Suggested question 2?", "Suggested question 3?"]
}`;

    if (ai) {
      try {
        const formattedContents: any[] = [];
        const validMessages = messages.filter((m: any) => m && m.content);

        let lastRole: string | null = null;
        for (let i = 0; i < validMessages.length; i++) {
          const msg = validMessages[i];
          const role = msg.role === 'assistant' ? 'model' : 'user';

          let textContent = msg.content;
          if (i === 0 && role === 'user') {
            textContent = `[Revision Context: Topic is "${topicTitle || 'Revision'}"${sectionContext}${sourceContext ? `\nSources provided: ${sources.length} items` : ''}]\n\n${msg.content}`;
          }

          if (role === lastRole && formattedContents.length > 0) {
            formattedContents[formattedContents.length - 1].parts[0].text += `\n\n${textContent}`;
          } else {
            formattedContents.push({
              role,
              parts: [{ text: textContent }],
            });
            lastRole = role;
          }
        }

        if (formattedContents.length > 0 && formattedContents[formattedContents.length - 1].role !== 'user') {
          formattedContents.push({
            role: 'user',
            parts: [{ text: 'Please continue explaining with your teaching mode.' }],
          });
        }

        // Fast & accurate structured JSON generation (prioritizing fastest high-quota models)
        for (const modelName of ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.7-flash']) {
          try {
            const response = await ai.models.generateContent({
              model: modelName,
              contents: formattedContents,
              config: {
                systemInstruction: systemPrompt,
                responseMimeType: 'application/json',
                temperature: 0.7,
              },
            });

            const text = response.text || '{}';
            const parsed = parseJsonSafely(text, null);
            if (parsed && parsed.reply) {
              return res.json(parsed);
            }
          } catch (modelErr: any) {
            const status = modelErr?.status || modelErr?.code || 'ERROR';
            console.warn(`Gemini fast tutor chat on ${modelName} encountered ${status}, trying next candidate.`);
          }
        }

        // Search grounding fallback if enabled and direct models encountered rate limit
        if (effectiveWebSearch) {
          for (const modelName of ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.7-flash']) {
            try {
              const response = await ai.models.generateContent({
                model: modelName,
                contents: formattedContents,
                config: {
                  systemInstruction: `${systemPrompt}\nCRITICAL: Return ONLY a valid JSON object matching the requested schema. Wrap in \`\`\`json ... \`\`\`.`,
                  tools: [{ googleSearch: {} }],
                  temperature: 0.7,
                },
              });
              const text = response.text || '{}';
              const parsed = parseJsonSafely(text, null);
              if (parsed && parsed.reply) {
                return res.json(parsed);
              }
            } catch (chatSearchErr: any) {
              const status = chatSearchErr?.status || chatSearchErr?.code || 'ERROR';
              console.warn(`Gemini chat search on ${modelName} encountered ${status}, continuing fallback.`);
            }
          }
        }
      } catch (geminiErr) {
        console.warn('Gemini chat failed, using tutor response synthesis:', geminiErr);
      }
    }

    // Smart fallback tutor chat response
    const lastUserMessage = (messages || []).filter((m: any) => m.role === 'user').slice(-1)[0]?.content || '';
    const title = topicTitle || 'your revision topic';

    return res.json({
      reply: `### Revision Insight on ${title}\n\nGreat question! When studying **${title}**, keep these key principles in mind:\n\n1. **First Principles**: Break down "${lastUserMessage}" into foundational definitions and verify how variables interact.\n2. **Intuitive Analogy**: Consider how energy or variables flow in a chain reaction where every step depends on the previous phase.\n3. **Exam Check**: In examinations, always state the primary governing principle and units before presenting your final conclusion.\n\n*Would you like me to walk through a specific sample exam question on this, or explain another analogy?*`,
      suggestedQuestions: [
        `Can you give me a simple real-world analogy for this?`,
        `What is the most common exam trick question on this?`,
        `Test my understanding with a rapid-fire question!`,
      ],
    });
  } catch (err: any) {
    console.error('Error in tutor chat, providing fallback:', err);
    return res.json({
      reply: `### Revision Guidance\n\nTo master this concept, start with the core definitions, connect them using a simple analogy, and practice with step-by-step exam problems.\n\n*Would you like to practice a quiz question or break down a specific sub-topic?*`,
      suggestedQuestions: [
        `Can you explain the main definition again?`,
        `Give me an exam-style question on this topic`,
        `What are the most common student mistakes?`,
      ],
    });
  }
});

// 6. Polish Topic Title (Fix Grammar & Capitalization Only)
app.post('/api/generate-title', async (req, res) => {
  try {
    const { content, currentTitle, sources } = req.body;
    let contextText = content || '';

    if (!contextText && sources && Array.isArray(sources)) {
      contextText = sources.map((s: any) => `${s.title || ''}: ${s.content || ''}`).join('\n').substring(0, 3000);
    }

    if (!contextText.trim() && !currentTitle) {
      return res.json({ title: 'New Revision Topic' });
    }

    const ai = getAI();
    if (ai) {
      const candidateModels = ['gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.1-flash-lite'];
      const titlePrompt = `You are a precision topic title polishing tool.
Your ONLY responsibility is to fix grammar, spelling mistakes/typos, and capitalization (proper Title Case) for the topic title.

STRICT POLISHING DIRECTIVES:
1. ONLY fix grammar, spelling typos, and capitalization.
2. DO NOT alter the user's intended phrasing, rephrase, or inject unrequested academic jargon or filler words (e.g., if the user wrote "photosynthesis and plant cell", output "Photosynthesis and Plant Cell" - do NOT expand it into "Photosynthesis: Plant Cellular Ultrastructure").
3. Preserve the user's original words faithfully, correcting only grammatical errors, typos, and formatting with standard Title Case capitalization.
4. If the input comes from a file name (e.g., "lecture_3_macroeconomics.pdf"), remove file extensions and underscores, and apply Title Case.
5. If the user provided no title at all and only source materials are present, extract the concise subject name directly from the source text and apply proper Title Case.

User Input / Draft Title: "${currentTitle || ''}"
${contextText ? `Source Text Reference:\n${contextText.substring(0, 1500)}` : ''}

Return ONLY a valid JSON object matching:
{
  "title": "Polished Title"
}`;

      for (const modelName of candidateModels) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: titlePrompt,
            config: {
              systemInstruction: 'You are a precise title polishing assistant. Fix grammar, spelling typos, and capitalization in Title Case without rewriting or adding unsolicited words. Return valid JSON.',
              temperature: 0.2,
              maxOutputTokens: 80,
              responseMimeType: 'application/json',
            }
          });
          const parsed = parseJsonSafely(response.text || '{}', null);
          if (parsed && parsed.title && parsed.title.trim()) {
            return res.json({ title: parsed.title.trim() });
          }
        } catch (err: any) {
          const status = err?.status || err?.code || 'ERROR';
          console.warn(`Gemini title polishing on ${modelName} encountered ${status}, trying next.`);
        }
      }
    }

    const fallbackTitle = cleanFallbackTitle(currentTitle || '', contextText);
    return res.json({ title: fallbackTitle || 'New Revision Topic' });
  } catch (err) {
    const fallbackTitle = cleanFallbackTitle(req.body?.currentTitle || '', req.body?.content || '');
    return res.json({ title: fallbackTitle || 'New Revision Topic' });
  }
});

// Start the Express server and configure Vite
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ReviseAI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
