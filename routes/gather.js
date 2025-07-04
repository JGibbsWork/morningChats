// Enhanced gather.js with voicemail detection and better session ending
import pkg from 'twilio';
const { twiml } = pkg;
import { ctx } from '../memory/context.js';
import { log } from '../memory/log.js';
import { llmReply, llmReplyWithTools, generateConversationalResponse } from '../utils/llmReply.js';
import { notionClient } from '../utils/notionClient.js';
import { calendarClient } from '../utils/calendarClient.js';
import { getSession, endSession } from '../utils/sessionManager.js';

export async function handleGather(req, res) {
  const callSid = req.body.CallSid;
  const userInput = (req.body.SpeechResult || '').trim();

  console.log(`🎤 User said: "${userInput}"`);

  const response = new twiml.VoiceResponse();

  // **ENHANCED VOICEMAIL DETECTION** - this is key!
  if (isVoicemailMessage(userInput)) {
    console.log('🤖 VOICEMAIL DETECTED - Ending call and logging as missed');
    
    // **FIXED**: Mark session as voicemail BEFORE ending it
    const session = getSession(callSid);
    session.markAsVoicemail();
    
    // Log this as a missed call, not a successful session
    if (process.env.NOTION_LOGS_DB_ID) {
      await notionClient.logMissedCall(process.env.NOTION_LOGS_DB_ID, req.body.To, 'voicemail-answered');
      console.log('📝 Voicemail interaction logged as missed call');
    }
    
    // Clean up and hang up - session already marked as ended in markAsVoicemail()
    await endSession(callSid);
    ctx.clear(callSid);
    
    response.say({ voice: 'Google.en-US-Neural2-I' }, 'Voicemail detected. Call back when you can actually talk.');
    response.hangup();
    
    return res.type('text/xml').send(response.toString());
  }

  // Enhanced session ending detection
  if (isSessionEnding(userInput)) {
    console.log('🏁 User ending session...');
    return await handleSessionEnd(callSid, userInput, response, res);
  }

  // Check for Twilio call hangup
  if (req.body.CallStatus === 'completed' || req.body.CallStatus === 'no-answer') {
    console.log('📞 Call ended by Twilio status');
    await endSession(callSid);
    return res.status(200).send(); // Just acknowledge, no TwiML needed
  }

  try {
    // Get session manager
    const session = getSession(callSid);
    const history = ctx.get(callSid) || [];
    
    // **IMPORTANT**: Track that this is a real conversation, not voicemail
    if (session.sessionData.sessionType === 'unknown') {
      session.sessionData.sessionType = 'conversation';
    }
    
    // Add user input to history
    history.push({ role: 'user', content: userInput });

    // Check if this might need tools
    const needsTools = /\b(add|create|schedule|remind|put.*calendar|todo)\b/i.test(userInput);
    
    let assistantReply;
    let toolResult = null;

    if (needsTools) {
      console.log('🔧 Processing tool request...');
      const llmResponse = await llmReplyWithTools(history);
      
      if (llmResponse.type === 'tool_call') {
        toolResult = await executeToolCall(llmResponse);
        assistantReply = llmResponse.originalResponse || 
          (toolResult.success ? `Got it. ${toolResult.message}` : `Couldn't add that. ${toolResult.message}`);
        
        // Track this as a decision
        if (toolResult.success) {
          session.addDecision(`Added: ${toolResult.item || llmResponse.task || llmResponse.title}`);
        }
      } else {
        assistantReply = llmResponse.content;
      }
    } else {
      // Feature 2: Use enhanced conversational response if we have day analysis
      if (session.sessionData.dayAnalysis) {
        console.log('🧠 Generating contextual response...');
        try {
          assistantReply = await generateConversationalResponse(
            session.sessionData.conversation,
            session.sessionData.dayAnalysis
          );
        } catch (error) {
          console.error('Contextual response failed, using basic LLM:', error);
          assistantReply = await llmReply(history);
        }
      } else {
        // Fallback to basic LLM
        console.log('📝 Using basic LLM response...');
        assistantReply = await llmReply(history);
      }
    }

    // Add assistant reply to history
    history.push({ role: 'assistant', content: assistantReply });
    ctx.set(callSid, history);

    // Track in session manager
    session.addExchange(userInput, assistantReply, {
      toolUsed: toolResult?.tool,
      toolSuccess: toolResult?.success
    });

    // Track commitments and decisions
    if (/\b(will|going to|plan to|commit|promise)\b/i.test(userInput)) {
      session.addDecision(`User commitment: ${userInput}`);
    }

    // Legacy logging (keep for backwards compatibility)
    await log.insertOne({
      callSid,
      timestamp: new Date(),
      userInput,
      assistantReply,
      toolUsed: toolResult ? toolResult.tool : null,
      toolSuccess: toolResult ? toolResult.success : null,
      sessionState: session.sessionData.state,
      source: 'morningCoach'
    });

    console.log(`🤖 Assistant reply: "${assistantReply}"`);

    response.say({ voice: 'Google.en-US-Neural2-I' }, assistantReply);
    response.gather({ 
      input: 'speech', 
      action: '/gather', 
      speechTimeout: 'auto',
      timeout: 8, // 8 second timeout for responsiveness
      finishOnKey: '#' // Allow # to end call
    });

    res.type('text/xml').send(response.toString());

  } catch (error) {
    console.error('❌ Gather handler error:', error);
    
    // Fallback response
    const fallbackReply = "Let's stay focused. What's your main priority?";
    
    response.say({ voice: 'Google.en-US-Neural2-I' }, fallbackReply);
    response.gather({ input: 'speech', action: '/gather', speechTimeout: 'auto' });

    res.type('text/xml').send(response.toString());
  }
}

// **ENHANCED VOICEMAIL DETECTION** - This is the key function!
function isVoicemailMessage(userInput) {
  const voicemailPatterns = [
    // Standard voicemail messages
    /not available.*leave.*message/i,
    /can't come to.*phone/i,
    /leave.*message.*after.*tone/i,
    /press.*for.*delivery.*options/i,
    /nothing.*recorded.*hang.*up/i,
    /message.*after.*tone.*hang.*up/i,
    /simply.*hang.*up/i,
    /your.*message.*after.*beep/i,
    /please.*leave.*your.*name/i,
    /mailbox.*full/i,
    /unavailable.*right.*now/i,
    
    // Phone number patterns (voicemail often just says the number)
    /^\d{3}[-.]?\d{3}[-.]?\d{4}\.?$/,  // 8583866200 or 858-386-6200
    /^you'?ve reached.*/i,
    /^this is.*(voicemail|message)/i,
    /^hello.*not here/i,
    /^sorry.*missed.*call/i,
    
    // **ENHANCED**: Patterns specifically for your case
    /^\d{3}\s*\d{3}\.?$/,  // "866 200." pattern
    /^\d{2,4}\s*\d{2,4}\.?$/,  // Two number groups with optional period
    /^at the tone/i,
    /^please record/i,
    
    // Common voicemail endings
    /when you have finished recording.*hang up/i,
    /you may hang up/i,
    /recording.*hang up/i
  ];
  
  // **ENHANCED**: More sophisticated detection
  const trimmedInput = userInput.trim();
  
  // Check for the specific "866 200." pattern from your logs
  if (/^\d{3}\s*\d{3}\.?$/.test(trimmedInput)) {
    console.log(`🤖 Detected phone number pattern: "${trimmedInput}"`);
    return true;
  }
  
  // Check if it's suspiciously short and numeric (likely voicemail fragment)
  const isShortNumeric = /^\d{3,10}\.?$/.test(trimmedInput);
  const isJustNumbers = /^\d+[\s.]*\d*\.?$/.test(trimmedInput);
  
  // Enhanced detection for automated messages
  const isAutomatedMessage = voicemailPatterns.some(pattern => pattern.test(userInput.toLowerCase()));
  
  if (isAutomatedMessage || isShortNumeric || isJustNumbers) {
    console.log(`🤖 Voicemail detection triggered by: ${isAutomatedMessage ? 'Pattern match' : isShortNumeric ? 'Short numeric' : 'Just numbers'}`);
    return true;
  }
  
  return false;
}

// Better session ending detection
function isSessionEnding(userInput) {
  const endPhrases = [
    /^(no|nothing else|that'?s it|i'?m done|all set|wrap up|finished|bye|goodbye)$/i,
    /^(good|ok|sounds good|alright|perfect)\s*(bye|goodbye|thanks)?$/i,
    /^(thanks|thank you|appreciate it)\s*(bye|goodbye)?$/i,
    /end call|hang up|gotta go|have to go/i,
    /see you tomorrow|talk tomorrow|tomorrow/i
  ];
  
  return endPhrases.some(pattern => pattern.test(userInput.trim()));
}

// Enhanced session ending - ONLY called from gather, not status
async function handleSessionEnd(callSid, userInput, response, res) {
  try {
    console.log('🏁 Processing session end...');
    
    // Get the session data before ending it
    const session = getSession(callSid);
    const conversationHistory = ctx.get(callSid) || [];
    
    // Extract session insights for Notion
    const sessionInsights = extractSessionInsights(conversationHistory, session);
    
    // **CRITICAL**: Mark session as ending properly to prevent double logging
    session.setState('ending');
    
    // End the session (this saves to MongoDB) - ONLY ONCE
    const sessionData = await endSession(callSid);
    
    // Clean up context
    ctx.clear(callSid);
    
    // Final response
    const endMessage = getEndingMessage(sessionInsights);
    
    response.say({ voice: 'Google.en-US-Neural2-I' }, endMessage);
    response.hangup();
    
    console.log('✅ Session ended and logged successfully');
    return res.type('text/xml').send(response.toString());
    
  } catch (error) {
    console.error('❌ Error ending session:', error);
    
    // Fallback ending
    response.say({ voice: 'Google.en-US-Neural2-I' }, 'Session complete. Talk tomorrow!');
    response.hangup();
    return res.type('text/xml').send(response.toString());
  }
}

// **ENHANCED**: Extract insights with better analysis
function extractSessionInsights(conversationHistory, session) {
  const insights = {
    date: new Date().toISOString().split('T')[0],
    priorities: [],
    mood: 'Neutral',
    energyLevel: 'Medium',
    notes: ''
  };
  
  // Extract priorities from conversation
  const userMessages = conversationHistory
    .filter(msg => msg.role === 'user')
    .map(msg => msg.content);
  
  // Look for task mentions and commitments
  const taskMentions = [];
  userMessages.forEach(msg => {
    // Look for specific task names from their habits
    if (session.sessionData.todaysPlan?.habits) {
      session.sessionData.todaysPlan.habits.forEach(habit => {
        if (msg.toLowerCase().includes(habit.text.toLowerCase().split(' ')[0])) {
          taskMentions.push(habit.text);
        }
      });
    }
    
    // Look for time commitments
    if (/\b(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i.test(msg)) {
      const timeMatch = msg.match(/\b(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i);
      if (timeMatch) {
        taskMentions.push(`${timeMatch[0]} commitment made`);
      }
    }
    
    // Look for specific action words
    const actionMatches = msg.match(/\b(start|begin|do|work on|focus on)\s+([^.!?]*)/gi);
    if (actionMatches) {
      actionMatches.forEach(match => {
        taskMentions.push(match.trim());
      });
    }
  });
  
  insights.priorities = [...new Set(taskMentions)].slice(0, 3); // Top 3 unique priorities
  
  // **ENHANCED**: Better mood analysis from conversation tone
  const combinedText = userMessages.join(' ').toLowerCase();
  if (/good|great|excellent|awesome|ready|excited|energized|yes|absolutely|perfect/.test(combinedText)) {
    insights.mood = 'Positive';
    insights.energyLevel = 'High';
  } else if (/tired|slow|difficult|hard|struggle|overwhelmed|no|maybe|unsure/.test(combinedText)) {
    insights.mood = 'Low';
    insights.energyLevel = 'Low';
  } else if (/ok|fine|decent|normal|alright|sure/.test(combinedText)) {
    insights.mood = 'Neutral';
    insights.energyLevel = 'Medium';
  } else if (/focused|concentrate|priority|important|urgent/.test(combinedText)) {
    insights.mood = 'Focused';
    insights.energyLevel = 'High';
  }
  
  // Create notes summary
  const commitments = session.sessionData.decisions || [];
  const keyPoints = [];
  
  if (commitments.length > 0) {
    keyPoints.push(`Made ${commitments.length} commitments`);
  }
  
  if (insights.priorities.length > 0) {
    keyPoints.push(`Focus: ${insights.priorities[0]}`);
  }
  
  // Add conversation quality assessment
  if (userMessages.length > 3) {
    keyPoints.push('Extended conversation');
  } else if (userMessages.length > 1) {
    keyPoints.push('Brief interaction');
  }
  
  insights.notes = keyPoints.join('. ') || 'Quick check-in completed';
  
  return insights;
}

// Get appropriate ending message based on session
function getEndingMessage(insights) {
  const messages = [
    'Good session. Execute those plans.',
    'Solid check-in. Make it happen.',
    'Plans set. Time to work.',
    'Clear priorities. Go execute.',
    'Session logged. Get after it.'
  ];
  
  if (insights.priorities.length > 0) {
    const priority = insights.priorities[0];
    // Shorten long priorities for voice
    const shortPriority = priority.length > 30 ? 
      priority.substring(0, 30).split(' ').slice(0, -1).join(' ') : 
      priority;
    return `${shortPriority} locked in. Execute.`;
  }
  
  return messages[Math.floor(Math.random() * messages.length)];
}

async function executeToolCall(toolCall) {
  try {
    switch (toolCall.action) {
      case 'add_task':
        if (process.env.NOTION_TASKS_DB_ID) {
          const result = await notionClient.addTask(process.env.NOTION_TASKS_DB_ID, {
            title: toolCall.task,
            priority: 'Medium'
          });
          
          return {
            tool: 'add_task',
            success: !!result,
            message: result ? 'Added to your tasks.' : 'Task creation failed.',
            item: toolCall.task
          };
        }
        return { tool: 'add_task', success: false, message: 'Tasks not configured.' };

      case 'add_event':
        if (process.env.GOOGLE_CALENDAR_ACCESS_TOKEN) {
          const result = await calendarClient.addEvent({
            title: toolCall.title,
            time: toolCall.time
          });
          
          return {
            tool: 'add_event',
            success: !!result,
            message: result ? 'Added to your calendar.' : 'Calendar event failed.',
            item: `${toolCall.title} at ${toolCall.time}`
          };
        }
        return { tool: 'add_event', success: false, message: 'Calendar not configured.' };

      default:
        return { tool: 'unknown', success: false, message: 'Unknown action.' };
    }
  } catch (error) {
    console.error('Tool execution error:', error);
    return { 
      tool: toolCall.action, 
      success: false, 
      message: 'Something went wrong.' 
    };
  }
}