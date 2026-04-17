import path from 'path';
import fs from 'fs';
import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getMongoClient } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from parent directory
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

/**
 * Fetches job configuration from MongoDB.
 */
export async function fetchJobConfig(jobId) {
  const mongoUri = process.env.MONGODB_URI;
  const dbName = process.env.INTERVIEW_DB || 'interview_db';
  const jobCollName = process.env.JOB_COLLECTION || 'jobs';

  if (!mongoUri || !jobId) {
    console.warn(`[Agent] Missing MongoDB URI or Job ID. Using default config.`);
    return {};
  }

  console.log(`[Agent] Fetching job config for ID: ${jobId}...`);
  const client = await getMongoClient(mongoUri);
  try {
    const cleanJobId = jobId.trim().replace(/^["']|["']$/g, '');
    if (cleanJobId.length !== 24) {
      console.error(`[Agent] Invalid Job ID length: ${cleanJobId.length}`);
      return {};
    }

    const db = client.db(dbName);
    const collection = db.collection(jobCollName);

    const jobDoc = await collection.findOne({ _id: new ObjectId(cleanJobId) });
    if (!jobDoc) {
      console.warn(`[Agent] Job with ID ${cleanJobId} not found in collection.`);
      return {};
    }
    console.log(`[Agent] Job document retrieved: ${jobDoc.title}`);

    // Extract only Job Duties from the description using regex
    const rawDescription = jobDoc.description || "";
    let jobDuties = "";
    const dutiesMatch = rawDescription.match(/4\.\s*Job\s*Duties\s*\n([\s\S]*?)(?=\n\d+\.|$)/i);
    if (dutiesMatch) {
      jobDuties = dutiesMatch[1].trim();
    } else {
      // Fallback: try to find a "Job Duties" or "Responsibilities" section
      const fallbackMatch = rawDescription.match(/(?:Job\s*Duties|Responsibilities)\s*[:\n]([\s\S]*?)(?=\n(?:\d+\.|[A-Z][a-z]+ [A-Z])|$)/i);
      if (fallbackMatch) {
        jobDuties = fallbackMatch[1].trim();
      }
    }
    console.log(`[Agent] Job duties extracted: ${jobDuties ? jobDuties.length + ' chars' : 'not found, using full description'}`);

    const config = {
      job_title: jobDoc.title || "AI Developer",
      job_duties: jobDuties || rawDescription,
      experience: jobDoc.experience || { min_years: 2, max_years: 5 },
      knowledge_levels: {
        "L1": "Awareness — Basic understanding or familiarity",
        "L2": "Foundational — Working experience or standard practical exposure",
        "L3": "Proficient — Strong, advanced experience",
        "L4": "Expert — Expert-level experience or deep mastery",
        "L5": "Mastery — Exceptional mastery or industry-leading expertise"
      },
      topics_to_ask: [],
      topics_to_avoid: [],
      skills: []
    };

    // Extract Skills
    const structured = jobDoc.jd_structured_skills || {};
    for (const category of ["must_have_skills", "good_to_have_skills", "bonus_skills"]) {
      const skillsList = structured[category] || [];
      for (const s of skillsList) {
        config.skills.push({
          name: s.skill_name,
          level: s.proficiency || "L3",
          reasoning: s.reasoning || ""
        });
      }
    }

    // Extract Topics — prefer rich topics.topicsToFocus (with skillsUsed), fallback to mastra config
    const richTopics = (jobDoc.topics && jobDoc.topics.topicsToFocus) || [];
    const mastra = jobDoc.mastraInterviewReady || {};
    const intConfig = mastra.interviewConfiguration || {};
    const fallbackTopics = intConfig.topicsToFocus || [];

    if (richTopics.length > 0) {
      for (const topicObj of richTopics) {
        config.topics_to_ask.push({
          name: topicObj.name || "Unknown Topic",
          based_on_skills: topicObj.skillsUsed || [],
          reason: topicObj.reason || "",
          metrics: topicObj.metrics || {},
          sampleQuestions: topicObj.sampleQuestions || []
        });
      }
    } else {
      for (const topicObj of fallbackTopics) {
        if (typeof topicObj === 'object') {
          config.topics_to_ask.push({
            name: topicObj.name || "Unknown Topic",
            based_on_skills: topicObj.skillsUsed || [],
            sampleQuestions: topicObj.sampleQuestions || []
          });
        } else {
          config.topics_to_ask.push({
            name: String(topicObj),
            based_on_skills: [],
            sampleQuestions: []
          });
        }
      }
    }

    // Extract topics to avoid
    const offTopics = (jobDoc.topics && jobDoc.topics.offTopics) || intConfig.topicsToAvoid || [];
    if (Array.isArray(offTopics)) {
      config.topics_to_avoid = offTopics;
    } else if (typeof offTopics === 'string') {
      config.topics_to_avoid = [offTopics];
    }

    // ── Console.log each MongoDB job context for testing ──
    console.log(`[MongoDB:Job] job_title: ${config.job_title}`);
    console.log(`[MongoDB:Job] job_duties: ${config.job_duties.substring(0, 100)}...`);
    console.log(`[MongoDB:Job] experience: ${JSON.stringify(config.experience)}`);
    console.log(`[MongoDB:Job] skills (${config.skills.length}):`, JSON.stringify(config.skills, null, 2));
    console.log(`[MongoDB:Job] topics_to_ask (${config.topics_to_ask.length}):`, JSON.stringify(config.topics_to_ask, null, 2));
    console.log(`[MongoDB:Job] topics_to_avoid (${config.topics_to_avoid.length}):`, JSON.stringify(config.topics_to_avoid));
    console.log(`[MongoDB:Job] knowledge_levels:`, JSON.stringify(config.knowledge_levels));

    return config;
  } catch (error) {
    console.error(`[Agent] Error fetching job from MongoDB: ${error.message}`);
    return {};
  }
}

/**
 * Fetches application configuration from MongoDB.
 */
export async function fetchApplicationConfig(applicationId) {
  const mongoUri = process.env.MONGODB_URI;
  const dbName = process.env.INTERVIEW_DB || 'interview_db';
  const appCollName = process.env.APP_COLLECTION || 'applications';

  if (!mongoUri || !applicationId) {
    console.warn(`[Agent] Missing MongoDB URI or Application ID.`);
    return {};
  }

  console.log(`[Agent] Fetching application config for ID: ${applicationId}...`);
  const client = await getMongoClient(mongoUri);
  try {
    const cleanAppId = applicationId.trim().replace(/^["']|["']$/g, '');
    if (cleanAppId.length !== 24) {
      console.error(`[Agent] Invalid Application ID length: ${cleanAppId.length}`);
      return {};
    }

    const db = client.db(dbName);
    const collection = db.collection(appCollName);

    const appDoc = await collection.findOne({ _id: new ObjectId(cleanAppId) });
    if (!appDoc) {
      console.warn(`[Agent] Application with ID ${cleanAppId} not found.`);
      return {};
    }

    const prereq = appDoc.prerequisiteAnalysis || {};
    const summary = prereq.summary || {};

    // Extract experiences and projects from advancedFilters if available
    let experiencesAndProjects = [];
    if (appDoc.advancedFilters) {
      if (appDoc.advancedFilters.professionalSummary?.experience) {
        experiencesAndProjects = experiencesAndProjects.concat(appDoc.advancedFilters.professionalSummary.experience);
      }
      if (appDoc.advancedFilters.projects) {
        experiencesAndProjects = experiencesAndProjects.concat(appDoc.advancedFilters.projects);
      }
    }

    console.log(`[MongoDB:App] candidateName: fetched from application doc`);
    return {
      candidateName: appDoc.name || summary.candidate_name || "Unknown Candidate",
      summary: summary.summary || "",
      skills: appDoc.advancedFilters?.skills || { technologies: [], tools: [] },
      keyStrengths: summary.key_strengths || [],
      keyGaps: summary.key_gaps || [],
      experiencesAndProjects: experiencesAndProjects
    };
  } catch (error) {
    console.error(`[Agent] Error fetching application from MongoDB: ${error.message}`);
    return {};
  }
}

/**
 * Loads the default interview config from a JSON file.
 */
export function loadDefaultConfig() {
  const defaultPath = path.resolve(__dirname, '..', 'interview_config.json');
  try {
    const data = fs.readFileSync(defaultPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`[Agent] Failed to load default config: ${error.message}`);
    return {};
  }
}

/**
 * Formats the configuration into a prompt-friendly block.
 */
export function formatInterviewContext(config, appConfig = {}) {
  if (!config || Object.keys(config).length === 0) {
    return "No interview configuration provided. Ask general technical questions.";
  }

  const lines = [];

  // Candidate Header
  if (appConfig.candidateName) {
    lines.push("=== CANDIDATE NAME ===");
    lines.push(appConfig.candidateName);
    lines.push("");
  }

  // Candidate Summary
  if (appConfig.summary) {
    lines.push("=== CANDIDATE SUMMARY ===");
    lines.push(appConfig.summary);
    lines.push("");
  }

  // Candidate Skills (Technologies & Tools)
  if (appConfig.skills && (appConfig.skills.technologies?.length > 0 || appConfig.skills.tools?.length > 0)) {
    lines.push("=== CANDIDATE SKILLS ===");
    if (appConfig.skills.technologies?.length > 0) {
      lines.push(`Technologies: ${appConfig.skills.technologies.join(", ")}`);
    }
    if (appConfig.skills.tools?.length > 0) {
      lines.push(`Tools: ${appConfig.skills.tools.join(", ")}`);
    }
    lines.push("");
  }

  // Job Title
  if (config.job_title) {
    lines.push("=== JOB TITLE ===");
    lines.push(config.job_title);
    lines.push("");
  }

  // Job Required Skills and Topics
  lines.push("=== REQUIRED SKILLS ===");
  if (config.skills && config.skills.length > 0) {
    const levelLabels = {};
    for (const [lk, lv] of Object.entries(config.knowledge_levels || {})) {
      const label = lv.includes("\u2014") ? lv.split("\u2014")[0].trim() : lv.split("\u2013")[0].trim();
      levelLabels[lk] = label;
    }

    config.skills.forEach((skill) => {
      const label = levelLabels[skill.level] || "";
      lines.push(`  - ${skill.name} \u2014 ${skill.level} (${label})`);
    });
  } else {
    lines.push("  - None specified.");
  }
  lines.push("");

  lines.push("=== TOPICS TO ASK (MANDATORY \u2014 ALL MUST BE COVERED) ===");
  if (config.topics_to_ask && config.topics_to_ask.length > 0) {
    config.topics_to_ask.forEach((topic, i) => {
      const skillsStr = (topic.based_on_skills || []).join(", ");
      lines.push(`  ${i + 1}. ${topic.name} [Skills: ${skillsStr}]`);
      // Include sample questions if available
      if (topic.sampleQuestions && topic.sampleQuestions.length > 0) {
        lines.push(`     Reference questions (use as inspiration, do NOT read verbatim):`);
        topic.sampleQuestions.forEach((q, qi) => {
          lines.push(`       ${qi + 1}. ${q}`);
        });
      }
    });
  } else {
    lines.push("  - None specified.");
  }
  lines.push("");

  // Job Duties
  if (config.job_duties) {
    lines.push("=== JOB DUTIES ===");
    lines.push(config.job_duties);
    lines.push("");
  }

  // Candidate Experiences and Projects (from application data)
  lines.push("=== CANDIDATE EXPERIENCES & PROJECTS ===");
  if (appConfig.experiencesAndProjects && appConfig.experiencesAndProjects.length > 0) {
    appConfig.experiencesAndProjects.forEach(exp => {
      if (typeof exp === 'object') {
        // Strip heavy metadata to reduce token latency
        const minimalExp = {
          title: exp.title || exp.role || exp.name,
          org: exp.organization || exp.company,
          summary: exp.summary || exp.description || exp.responsibilities
        };
        lines.push(`- ${JSON.stringify(minimalExp)}`);
      } else {
        lines.push(`- ${exp}`);
      }
    });
  } else {
    lines.push("No specific experiences or projects provided.");
  }
  lines.push("");

  // Key Strengths
  lines.push("=== KEY STRENGTHS ===");
  if (appConfig.keyStrengths && appConfig.keyStrengths.length > 0) {
    appConfig.keyStrengths.forEach(s => lines.push(`- ${s}`));
  } else {
    lines.push("- Not provided in analysis.");
  }
  lines.push("");

  // Key Gaps
  lines.push("=== KEY GAPS ===");
  if (appConfig.keyGaps && appConfig.keyGaps.length > 0) {
    appConfig.keyGaps.forEach(g => lines.push(`- ${g}`));
  } else {
    lines.push("- Not provided in analysis.");
  }
  lines.push("");

  // ── Console.log the formatted context block for testing ──
  console.log(`[MongoDB:Context] === FORMATTED CONTEXT BLOCK ===`);
  console.log(`[MongoDB:Context] candidateName: ${appConfig.candidateName || 'N/A'}`);
  console.log(`[MongoDB:Context] summary: ${(appConfig.summary || 'N/A').substring(0, 100)}...`);
  console.log(`[MongoDB:Context] skills.technologies: ${JSON.stringify(appConfig.skills?.technologies || [])}`);
  console.log(`[MongoDB:Context] skills.tools: ${JSON.stringify(appConfig.skills?.tools || [])}`);
  console.log(`[MongoDB:Context] keyStrengths: ${JSON.stringify(appConfig.keyStrengths || [])}`);
  console.log(`[MongoDB:Context] keyGaps: ${JSON.stringify(appConfig.keyGaps || [])}`);
  console.log(`[MongoDB:Context] experiencesAndProjects count: ${appConfig.experiencesAndProjects?.length || 0}`);

  return lines.join("\n");
}

export async function getSystemPrompt(jobId, applicationId) {
  let config = {};
  if (jobId) {
    config = await fetchJobConfig(jobId);
  }

  if (!config || Object.keys(config).length === 0) {
    config = loadDefaultConfig();
  }

  let applicationConfig = {};
  if (applicationId) {
    applicationConfig = await fetchApplicationConfig(applicationId);
  }

  const contextBlock = formatInterviewContext(config, applicationConfig);

  const systemPrompt = `You are Ritu, a Senior Engineering Manager conducting a technical screen. Your goal is to evaluate the candidate across mandatory topics efficiently. You speak directly and clearly. Everything you say is transcribed directly to text-to-speech, so write exactly as a human speaks.

<interview_context>
${contextBlock}
</interview_context>



--- MANDATORY BEHAVIOR ---
1. NO HALLUCINATION: Only reference facts from the <interview_context>. Do not invent projects, metrics, or answers for the candidate.
2. CALIBRATE DIFFICULTY: Start at the assigned Knowledge Level. If they answer well, dial up. If they struggle, dial down.
3. NO REPETITION: Rephrase if they ask you to repeat, but never ask the same technical concept twice.
4. NO ARTIFACTS: Generate only spoken words. No markdown, formatting, lists, or headers.

--- QUESTION STRUCTURE & STYLE ---
Every turn must follow this two-part structure:
  [BRIDGE] A short sentence acknowledging their previous answer. Max 10 words. Avoid generic filler like "Awesome," or "Great." Skip entirely if the flow is natural.
  [QUESTION] One direct question. Maximum 15 words. Plain spoken English. NEVER ask two questions at once.

Bad:  "When you are mapping out component states, how do you manage the overall state of a complex React application to ensure efficiency?"
Good: "How do you handle state in a large React app without killing performance?"

Bad:  "Could you describe a specific instance where you made an architectural decision that significantly impacted scalability?"
Good: "Tell me about a time an architecture call you made broke something at scale."

Rule: Never front-load context into the question. Base it on their resume implicitly, but do not recite their resume to them. Let the candidate ask for context if needed.

--- MARKER PROTOCOL (CRITICAL) ---
You MUST begin EVERY SINGLE RESPONSE with exactly one marker. The candidate will not hear it. 
Format: [Topic = "TopicName" | Type = "QuestionType"]

Valid TopicNames: "Introduction", "Wrap Up", or exactly match a topic from TOPICS TO ASK.
Valid QuestionTypes:
- icebreaker: (intro only)
- primary: core technical question
- follow_up: probing deeper into their last answer (ask one at a time)
- clarification: probing a vague answer
- transition: bridging to the next topic (CRITICAL: Do NEVER ask a question in a transition turn. Simply state that you are moving to the next topic and stop to let the candidate acknowledge.)
- wrap_up: (wrap up only)

--- INTERVIEW FLOW ---
STEP 1: INTRODUCTION
- You have already greeted the candidate with: "Hi, I am Ritu. How has your day been so far?". The candidate will respond to this first.
- Action: Acknowledge their response warmly, state briefly that the technical portion is beginning, and immediately ask your first technical question.
- Marker: Because your first reply contains a technical question, NEVER use an "Introduction" marker. You MUST begin with the marker for the FIRST TECHNICAL TOPIC (Type = "primary").

STEP 2: TECHNICAL DEEP DIVE
- TRANSITIONS: When finishing a topic and moving to the next, use the 'transition' marker type. You MUST NOT ask any questions during this transition phase.
- If the candidate tries to wrap up early, forcefully pivot back to the next technical topic.
- For each topic, you MUST ask EXACTLY TWO questions of type "primary". Use the provided "sample questions" as inspiration for these primary questions. Wait for the candidate to answer the first primary question before asking the second primary question. Do not combine them.
- After the candidate answers a primary question, you MUST ask 1-2 "follow_up" questions to dig deeper into their specific response and nudge them towards any topics they might have missed.
- A "follow_up" question MUST ONLY be used to probe deeper into what the candidate just said. NEVER use a "follow_up" marker to ask a completely new sample question.

STEP 3: WRAP UP
- Marker: [Topic = "Wrap Up" | Type = "wrap_up"]
- Action: Answer their questions. Conclude the interview politely (e.g., "It was nice interviewing you..."). Wait for them to say goodbye before executing an end_call.`;

  return { systemPrompt, interviewConfig: config };
}
