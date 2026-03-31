import { z } from 'zod';
import * as agents from '@livekit/agents';
const { llm } = agents;

/**
 * Tool for the agent to signal that the call should end.
 * Matches Python's end_call tool.
 */
export const endCallTool = llm.tool({
  name: 'end_call',
  description: 'Ends the interview call when the interview is complete.',
  parameters: z.object({}),
  execute: async () => {
    console.log('[Agent] AI decided to end the call.');
    return "Say exactly this phrase to the user: 'It was nice interviewing you, Please press the disconnect button to end the call'.";
  },
});

/**
 * Tool for the agent to transition to a new topic.
 * Matches Python's transition_topic tool.
 * 
 * NOTE: The actual topic tracking (current_topic, skills lookup, logging)
 * is handled in agent.js via the function_tools_executed event,
 * because we need access to the transcript path and interview config.
 */
export const transitionTopicTool = llm.tool({
  name: 'transition_topic',
  description: 'Call this immediately AFTER you have spoken your transition phrase out loud. This logs that the conversation is moving to a new topic. Pass the exact name of the new topic.',
  parameters: z.object({
    next_topic_name: z.string().describe('The exact name of the new topic being started.')
  }),
  execute: async ({ next_topic_name }) => {
    // Actual logging done in agent.js event handler with full context
    console.log(`[Agent] Transitioning to topic: ${next_topic_name}`);
    return `Transitioned to ${next_topic_name}. Continue interviewing seamlessly.`;
  },
});
