/*───────────────────────────────────────────────────────────────
  ArticuWrite — shared IELTS grader (aw-grader.js)

  The single source of truth for how an essay is graded. Both the student
  writing screen (write.html) and the reliability test page (test.html)
  call AW.grade(), so the test always measures the prompt that students
  actually get — a copy would silently drift out of sync.

  Depends on: aw-common.js (loaded first)
───────────────────────────────────────────────────────────────*/
(function (AW) {
  'use strict';

  function normaliseScores(r){
    if(r.scores){
      // FIX: Component scores MUST be whole numbers per IELTS marking convention.
      // Only the OVERALL band can be X.5. Round each component to nearest integer.
      ['TR','CC','LR','GRA'].forEach(function(k){
        if(r.scores[k] != null) r.scores[k] = Math.round(parseFloat(r.scores[k])||0);
      });
      var avg=(r.scores.TR+r.scores.CC+r.scores.LR+r.scores.GRA)/4;
      // IELTS convention: .25–.74 → .5, otherwise nearest whole band
      var whole=Math.floor(avg), frac=avg-whole;
      r.overall = frac<0.25 ? whole : (frac<0.75 ? whole+0.5 : whole+1);
    }
    return r;
  }
  async function gradeWithGemini(payload, geminiKey){
    var text=payload.writing||'', question=payload.question||'';
    var systemInstruction='You are a strict IELTS Writing examiner. Grade only the essay provided by the student. Every piece of feedback must quote directly from that essay. Never invent examples or use content from other essays.\n\n'+
      'IELTS BAND DESCRIPTORS:\n'+
      'TR/TA: Band 7=covers all parts, clear position, ideas developed. Band 6=addresses parts but some inadequately. Band 5=partial, limited. Band 4=minimal.\n'+
      'CC: Band 7=logical, varied cohesion, good paragraphing. Band 6=mostly coherent. Band 5=some org. Band 4=incoherent.\n'+
      'LR: Band 7=flexible range, minor errors. Band 6=adequate. Band 5=limited. Band 4=basic.\n'+
      'GRA: Band 7=complex structures, frequent error-free. Band 6=mix. Band 5=frequent errors. Band 4=many errors.\n\n'+
      'SCORING RULES:\n- Components: whole numbers or X.5 if borderline.\n- Overall = average of 4, round to 0.5.\n- Most students score 5-6. Band 7 = genuinely good. Band 8+ very rare.\n- Grammar errors → GRA ≤ 6. Basic vocab → LR ≤ 6.\n\n'+
      '[CONDITIONAL RULES — enforce strictly, do not overlook any]\n'+
      '1) LEXICAL RESOURCE & GRAMMAR — HARD LIMITS:\n'+
      '- Spelling: count the spelling mistakes. IF more than 5 (i.e. frequent, causing difficulty for the reader) THEN cap LR at Band 5 and warn in Vietnamese: "Sai chính tả trên 5 lỗi không thể đạt Band 6 tiêu chí Vocab". IF 1-5 (occasional slips) THEN cap LR at Band 6 and list every error found.\n'+
      '- IF there are basic punctuation errors or failure to capitalize proper nouns (e.g. "zoom" instead of "Zoom", "google meet" instead of "Google Meet") THEN cap GRA at Band 6.\n'+
      '- IF the student uses contractions (it\'s, don\'t) or informal vocabulary (e.g. "costly mistakes", "thanks to" instead of "due to") THEN penalize and require formal academic alternatives.\n'+
      '- IF a body paragraph consists entirely of simple sentences without subordinating conjunctions (although, whereas, provided that) or relative clauses (which, who, that) THEN flag as "Lack of Grammatical Variety" and warn that Band 7 in GRA requires a mix of complex sentence structures.\n'+
      '- Repetition: IF a topic-specific keyword (e.g. "online meetings") appears more than 2 times in one body paragraph, OR more than once in the Intro/Conclusion, THEN flag it as a repetition error and suggest pronouns or contextual synonyms — BUT only when the repetition shows a lack of vocabulary. ACCEPT the repetition if replacing it with a synonym would distort the meaning (e.g. fixed technical terms).\n'+
      '- IF the word "nowadays" is used THEN flag it as a cliché and demand removal or replacement.\n'+
      '- IF the student uses an unnatural word combination (e.g. "do a mistake" instead of "make a mistake", "heavy traffic jam" instead of "heavy traffic") THEN quote the phrase, label it "Unnatural Collocation", and give the correct academic alternative.\n'+
      '- IF the student uses informal phrasal verbs ("look into", "come up with", "get rid of") in an academic context THEN penalize the tone and suggest formal single-word equivalents ("investigate", "develop/invent", "eliminate").\n'+
      '2) TASK RESPONSE (CONTENT & LOGIC):\n'+
      '- IF an example or argument shifts context away from the prompt (prompt about "business" but student writes about "education"/"students") THEN flag as "Sai bối cảnh / Off-topic".\n'+
      '- IF an argument lacks real-world logic (e.g. "traffic noise" distracting someone "working from home", or "absent-mindedness" as a professional excuse) THEN counter-argue with a critical question exposing the logical flaw.\n'+
      '- IF the student introduces a new idea (especially at the end of a paragraph) without a supporting sentence THEN flag as "Lỗi liệt kê" (Listing error): the idea lacks development.\n'+
      '- IF the prompt does NOT ask to discuss "benefits and drawbacks" BUT the student includes them in the introductory paraphrase THEN flag as an inaccurate paraphrase.\n'+
      '- IF the opinion in the Conclusion contradicts or shifts away from the thesis statement in the Introduction THEN flag as "Inconsistent Position" and cap Task Response at Band 6.\n'+
      '- THESIS–TOPIC ALIGNMENT & SEMANTIC TARGET CHECK (high-priority, affects BOTH TR and CC). Do it in steps: (1) Extract the thesis statement — the explicit position/map usually at the end of the Introduction. (2) Identify its SEMANTIC TARGETS: the exact objects/policies/trends being evaluated (e.g. is the thesis promising to discuss drawbacks of "alternative energy" or of "fossil fuels"?). (3) Extract each Body paragraph\'s topic sentence (its opening sentence). (4) Check that the topic sentences evaluate the SAME semantic targets the thesis mapped.\n'+
      '  • FATAL ERROR 1 — Target Shift / Misaligned Focus: thesis maps arguments about Target A but a topic sentence discusses Target B (e.g. thesis = drawbacks of renewable energy, but Body 1 discusses drawbacks of fossil fuels). THEN cap TR at 6.0 (writer drifted off the promised topic — position not maintained) AND cap CC at 6.0 (broken progression, faulty referencing between Intro and Body). You MUST state exactly which semantic target was shifted (from what, to what) and quote the offending topic sentence.\n'+
      '  • FATAL ERROR 2 — Contradiction: a topic sentence takes a stance that contradicts the thesis. THEN cap BOTH TR and CC at 6.0.\n'+
      '  • SAFE EXCEPTION — Concession: if the thesis maps a concession about Target A ("While Target A has drawbacks, its benefits are greater") AND Body 1 covers drawbacks of Target A AND Body 2 covers benefits of Target A, this is PERFECT alignment — do NOT penalize; reward TR and CC for clear progression and note it as a strength.\n'+
      '3) COHERENCE & COHESION:\n'+
      '- IF an example merely rewrites the previous sentence with different vocabulary without adding specific concrete details THEN flag as "Invalid Example": an example must be more specific than the claim it supports.\n'+
      '- IF a Topic Sentence lists the specific main ideas to be discussed THEN advise keeping it broader with clear directional words (e.g. skeptical, advocate).\n'+
      '- IF a sentence states a result ("As a result, businesses reduce expenses") BUT the preceding sentence did not mention the corresponding cause (money/costs) THEN flag as a logical disconnect.\n'+
      '- IF transition words are combined redundantly ("Consequently, this...") THEN correct to a single cohesive device.\n'+
      '- Conclusion: IF it introduces new ideas THEN penalize. IF it copies body sentences word-for-word THEN advise paraphrasing. Concisely summarizing the main points IS acceptable and must NOT be penalized.\n'+
      '- IF the student starts almost every sentence with a basic transition ("Firstly,", "Secondly,", "Moreover,", "Furthermore,") THEN flag as "Mechanical Cohesion" and suggest referencing pronouns (this, these, such) or advanced cohesive structures ("Not only..., but...", "Another compelling reason is...").\n'+
      '- IF a body paragraph has fewer than 3 sentences OR discusses two completely unrelated main ideas THEN flag as "Paragraphing Error" and advise ONE central idea per paragraph with sufficient development.\n'+
      '[ANTI-OVER-CORRECTION PROTOCOL — evaluate the writer\'s real language, do not rewrite it in your own preferred style; do not unfairly downgrade]\n'+
      'PRECEDENCE: The specific hard-cap rules ABOVE always win. If a hard cap applies (e.g. spelling count, proper-noun capitalization, thesis/target misalignment, inconsistent position), keep the cap even if this protocol would otherwise raise the score. This protocol only PREVENTS unjustified downgrades where NO hard cap has triggered — it never lifts a cap.\n'+
      '1) LEXICAL RESOURCE — naturalness over complexity: do NOT "upgrade" vocabulary that is already natural, accurate and an appropriate academic collocation (accept "heavy financial burden"; do not force "significant financial burden"). Only correct vocabulary that is grammatically wrong, factually wrong, too informal/slang, or noticeably repetitive. Effective precise collocations deserve LR 7.0+; do NOT cap LR at 6.0 merely because the vocabulary is not "complex enough" in your view.\n'+
      '2) GRAMMAR — holistic: do NOT penalize clear pronoun referencing ("it/they/this/these") when the antecedent is logically clear; do not force noun repetition. If most sentences are error-free and meaning is clear, GRA MUST be 7.0+. A few minor slips (one missing article, one isolated subject-verb slip) do NOT drag a fundamentally strong essay down to 6.0.\n'+
      '3) COHERENCE & COHESION — reward implicit cohesion: do NOT penalize an essay for lacking mechanical transitions (First, Second, Moreover) when it cohering successfully through referencing ("this trend", "these drawbacks"), substitution, or logical sequencing. Flowing logically WITHOUT template transitions is a Band 7.0+ trait, not 6.0.\n'+
      'VERIFICATION BEFORE ANY 6.0: before downgrading LR, GRA or CC to 6.0 on the basis of error frequency, confirm the errors are genuinely "frequent" or "cause difficulty for the reader" per the official IELTS band descriptors. If errors are only occasional and meaning comes through clearly, the score must be at least 7.0. (This check does not apply to the hard-cap rules above, which stand regardless.)\n'+
      '[FEEDBACK FORMAT]\n'+
      'When any rule triggers, quote the exact sentence containing the error, use an arrow "=>", and give a precise, constructive correction based ONLY on the rules above. Keep the tone professional, direct and academic. Apply caps to the numeric scores accordingly — caps set the MAXIMUM; genuine weaknesses may score lower.\n\n'+
      'Return ONLY a JSON object with fields: scores(TR,CC,LR,GRA), overall, band_description, overall_feedback_vi, tr_comments(array of {paragraph_role,assessment_vi,suggestion_en,quote}), gra_errors(array of {wrong,correct,explanation_vi}), lr_issues(array of {original,better,explanation_vi,alternatives}), cc_feedback({assessment_vi,issues,suggestions}), corrected_text, repeated_errors_vi.\n'+
      '[MINIMUM DEPTH — a strong essay still gets detailed feedback]\n'+
      'A high band is NEVER a reason to return short or empty feedback. Band 7 is not perfect: it still contains imprecise word choice, slightly unnatural collocations, over-long sentences, weak or unsupported examples, and paragraphs that could be developed further. Praise alone is not useful feedback.\n'+
      '- ALWAYS return at least 3 items in "lr_issues" and at least 2 in "gra_errors". If the essay has no outright errors, use these slots for PRECISION upgrades: quote the exact wording used and offer a more precise, more natural, or more academic alternative, explaining in Vietnamese why the alternative is better. Never invent an error that is not in the text — an upgrade suggestion is not an error, so word the explanation as an improvement, not a mistake.\n'+
      '- ALWAYS return one tr_comments entry for EVERY paragraph of the essay (Opening, each Body, Conclusion), even when the paragraph is good: say specifically what works and what single change would strengthen it.\n'+
      '- "cc_feedback.assessment_vi" must name at least one concrete thing to improve, not only praise.\n'+
      '- "overall_feedback_vi" must state both what the student did well AND the single most important thing to work on next. Never end with praise only.\n'+
      '\n[GRAMMAR & VOCABULARY DEPTH IN BODY PARAGRAPHS — HIGHEST PRIORITY]\n'+
      'The primary learning goal is improving GRAMMAR ACCURACY and VOCABULARY PRECISION sentence by sentence.\n'+
      'For EVERY body paragraph, go through EACH sentence and:\n'+
      '  (a) GRAMMAR: identify subject-verb agreement errors, tense inconsistencies, article misuse (a/an/the), preposition errors, wrong word form (noun/verb/adj confusion), missing/extra words, run-on sentences, comma splices, dangling modifiers. Quote the exact wrong form → correct form → explain in Vietnamese WHY it is wrong.\n'+
      '  (b) VOCABULARY: identify unnatural collocations, imprecise word choice, informal words in formal context, repetitive nouns that should be replaced by pronouns or synonyms, words that are close but not the best fit. Quote the original word/phrase → suggest a more precise/natural/academic alternative → explain in Vietnamese what the difference is.\n'+
      'Do NOT summarise body paragraph grammar/vocab in one sentence. List individual errors and upgrades for each sentence that has room for improvement. A body paragraph with 4+ sentences should have at least 2–3 grammar items AND 2–3 vocabulary items reported.\n'+
      'Return ALL grammar items in the "gra_errors" array and ALL vocabulary items in the "lr_issues" array (do NOT bury them in tr_comments). Aim for 5–8 items in each array for a typical 250–350 word essay.\n'+
      'TOKEN RULES for tr_comments — follow strictly to keep output short:\n'+
      '- Do NOT quote whole paragraphs. For each comment set "paragraph_role" to the paragraph label ONLY: "Opening", "Body 1", "Body 2", "Body 3"... , or "Conclusion". Standard mapping: a 4-paragraph essay = Opening, Body 1, Body 2, Conclusion; a 5-paragraph essay = Opening, Body 1, Body 2, Body 3, Conclusion.\n'+
      '- Leave "quote" EMPTY unless you must point to ONE specific problematic sentence — then put ONLY that single sentence in "quote" (never the whole paragraph).\n'+
      '- "assessment_vi" is your comment on that paragraph. Keep it concise.';

    // Strip HTML tags from question (may contain <b>,<i> from rich text editor)
    var tmp=document.createElement('div'); tmp.innerHTML=question;
    var cleanQ=(tmp.textContent||tmp.innerText||question).replace(/\s+/g,' ').trim();

    var isTask1 = payload.taskType === 'task1';
    var attemptNote = payload.attempt >= 2
      ? '\n\nThis is revision attempt '+payload.attempt+'. In "repeated_errors_vi" (Vietnamese), note whether the student repeated the same TYPES of mistakes as a typical earlier draft (grammar/vocab/coherence) and encourage improvement. For attempt 1, leave repeated_errors_vi empty.'
      : '\n\nThis is the first attempt. Leave repeated_errors_vi empty. Give COMPLETE feedback on all 4 criteria so the student learns from the start.';

    // FIX: userMessage must match task type so AI doesn't confuse Task 1 with Task 2
    var userMessage;
    if (isTask1) {
      userMessage =
        'Grade this IELTS Academic Writing Task 1 response (data/chart/diagram description).\n\n'+
        'TASK PROMPT: '+cleanQ+'\n\n'+
        'STUDENT RESPONSE TO GRADE:\n---\n'+text+'\n---\n\n'+
        'This is Task 1 (NOT an opinion essay). Criterion 1 = Task Achievement (TA): assess overview presence, data accuracy, key features selected, comparisons made. '+
        'Do NOT expect or reward a personal opinion/thesis statement — Task 1 must not have one. '+
        'TA score (stored as TR field) MUST reflect: did the student cover the main features, include an overview, and make relevant comparisons?'+
        attemptNote;
    } else {
      userMessage =
        'Grade this IELTS Academic Writing Task 2 essay.\n\n'+
        'TASK PROMPT: '+cleanQ+'\n\n'+
        'STUDENT ESSAY TO GRADE:\n---\n'+text+'\n---\n\n'+
        'Task Response score MUST assess how directly the essay addresses the given task prompt. If the essay goes off-topic or misses the task, TR ≤ 5.'+
        attemptNote;
    }
    // Teacher's context rules override default IELTS strictness
    if (payload.aiNotes && payload.aiNotes.trim()) {
      userMessage += '\n\n=== TEACHER\'S GRADING RULES (HIGHEST PRIORITY — these OVERRIDE the default IELTS strictness above) ===\n'+
        payload.aiNotes.trim()+
        '\n\nYou MUST follow these teacher rules. Do NOT flag, mark, or deduct points for anything the teacher has explicitly allowed or told you to ignore. Only report errors that remain genuine problems given these rules. This keeps feedback appropriate for the class context and avoids overwhelming the student with irrelevant corrections.';
    }
    var prompt=systemInstruction+'\n\n'+userMessage;
    // ~30-token CEFR vocabulary summary (measured client-side) for reference
    if (payload.vocabSummary && payload.vocabSummary.trim()) {
      prompt += '\n\n=== VOCABULARY DATA (for Lexical Resource reference) ===\n' + payload.vocabSummary.trim();
    }

    // Model fallback chain — tries each in order if previous is unavailable/deprecated
    var GEMINI_MODELS = [
      'gemini-3.5-flash',   // primary: latest flagship Flash (May 2026), free tier
      'gemini-3.6-flash',   // fallback 1: newer lightweight, free tier (Jul 2026)
      'gemini-2.5-flash',   // fallback 2: older, shutting down Oct 2026
    ];
    var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

    var lastData = null;
    var geminiOk = false;

    for (var mi = 0; mi < GEMINI_MODELS.length; mi++) {
      var modelName = GEMINI_MODELS[mi];
      var resp = await fetch(GEMINI_BASE + modelName + ':generateContent?key=' + geminiKey, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature:0.1, topK:1, topP:0.1, candidateCount:1, maxOutputTokens:12000 }
        })
      });
      if (resp.ok) {
        lastData = await resp.json();
        geminiOk = true;
        break;
      }
      var errBody = await resp.json().catch(function(){ return {}; });
      var errMsg  = (errBody.error && errBody.error.message) || String(resp.status);
      var isModelErr = resp.status === 404 || resp.status === 400 ||
                       errMsg.indexOf('no longer available') !== -1 ||
                       errMsg.indexOf('deprecated') !== -1 ||
                       errMsg.indexOf('not found') !== -1;
      // Rate limit / quota → skip straight to Groq
      var isQuota = resp.status === 429 || errMsg.indexOf('quota') !== -1 || errMsg.indexOf('RESOURCE_EXHAUSTED') !== -1;
      if (isQuota || (!isModelErr && mi === GEMINI_MODELS.length - 1)) {
        break; // fall through to Groq
      }
      if (!isModelErr) {
        throw new Error('Gemini error: ' + errMsg); // auth/other — no point retrying
      }
      // model deprecated → try next Gemini model
    }

    // ── Groq fallback (llama-3.3-70b) ─────────────────────────────
    // Used when: all Gemini models are rate-limited, deprecated, or unavailable.
    // Groq's free tier is generous (14,400 req/day) and fast.
    // The prompt is identical — same JSON schema expected.
    if (!geminiOk) {
      var groqKey = (window.AW && AW.groqKey) ? AW.groqKey.get() : '';
      if (!groqKey) throw new Error('Gemini hết lượt và chưa có Groq API key. Vui lòng nhập Groq key trong phần cài đặt.');
      var groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + groqKey },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1, max_tokens: 12000, response_format: { type: 'json_object' }
        })
      });
      if (!groqResp.ok) {
        var groqErr = await groqResp.json().catch(function(){ return {}; });
        throw new Error('Groq error: ' + ((groqErr.error && groqErr.error.message) || groqResp.status));
      }
      var groqData = await groqResp.json();
      var groqRaw  = ((groqData.choices || [])[0] || {}).message;
      groqRaw = groqRaw ? groqRaw.content : '';
      if (!groqRaw) throw new Error('Groq trả về rỗng. Thử lại sau.');
      var groqClean = groqRaw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
      var gsi = groqClean.indexOf('{'), gei = -1, gdepth = 0;
      for (var gci = gsi; gci < groqClean.length; gci++) {
        if (groqClean[gci]==='{') gdepth++;
        else if (groqClean[gci]==='}') { gdepth--; if (gdepth===0){ gei=gci; break; } }
      }
      if (gsi===-1 || gei===-1) throw new Error('Lỗi định dạng phản hồi từ Groq. Vui lòng thử lại.');
      return normaliseScores(JSON.parse(groqClean.substring(gsi, gei+1)));
    }

    var raw = (((lastData.candidates || [])[0] || {}).content || {}).parts;
    raw = raw && raw[0] ? raw[0].text : '';
    if (!raw) throw new Error('Gemini trả về rỗng. Thử lại sau vài giây.');
    var clean = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi,'')
                   .replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
    var si = clean.indexOf('{'), depth = 0, ei = -1;
    for (var ci = si; ci < clean.length; ci++) {
      if (clean[ci]==='{') depth++;
      else if (clean[ci]==='}') { depth--; if (depth===0){ ei=ci; break; } }
    }
    if (si===-1 || ei===-1) throw new Error('Lỗi định dạng phản hồi từ Gemini. Vui lòng thử lại.');
    return normaliseScores(JSON.parse(clean.substring(si,ei+1)));
  }
  // Public API
  AW.grade = gradeWithGemini;
  AW.gradeNormalise = normaliseScores;

})(window.AW = window.AW || {});
