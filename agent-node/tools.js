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
