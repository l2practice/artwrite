/*--------------------------------------------------------------─
  ArticuWrite — shared IELTS grader (aw-grader.js)

  The single source of truth for how an essay is graded. Both the student
  writing screen (write.html) and the reliability test page (test.html)
  call AW.grade(), so the test always measures the prompt that students
  actually get — a copy would silently drift out of sync.

  Depends on: aw-common.js (loaded first)
--------------------------------------------------------------─*/
(function (AW) {
  'use strict';

  function normaliseScores(r){
    if(r.scores){
      // Round each component to whole number (IELTS: only overall can be X.5).
      // No null-check here — parseFloat(undefined)||0 = 0, safe against missing keys.
      // A half band ("5.5, borderline") goes DOWN: Math.round sent every 5.5 up to 6,
      // so the overall came out half a band above the one the AI had written in its
      // own description ("Overall đạt 5.5" next to a 6).
      var keys=['TR','CC','LR','GRA'].filter(function(k){ return r.scores[k]!==undefined && r.scores[k]!==null && r.scores[k]!==''; });
      if(!keys.length) return r;
      keys.forEach(function(k){
        var v = parseFloat(r.scores[k])||0;
        r.scores[k] = (v - Math.floor(v) === 0.5) ? Math.floor(v) : Math.round(v);
      });
      var avg=keys.reduce(function(t,k){ return t+r.scores[k]; },0)/keys.length;
      var whole=Math.floor(avg), frac=avg-whole;
      r.overall = frac<0.25 ? whole : (frac<0.75 ? whole+0.5 : whole+1);
      // the AI's text must not quote a different overall than the one shown
      r.band_description = AW.syncOverall(r.band_description, r.overall);
    }
    return r;
  }
  async function gradeWithGemini(payload, geminiKey){
    var text=payload.writing||'', question=payload.question||'';
    var systemInstruction='You are a strict IELTS Writing examiner. Grade only the essay provided by the student. Every piece of feedback must quote directly from that essay. Never invent examples or use content from other essays.\n\nThis is STEP 2 of 2. Step 1 already found every grammar error and vocabulary problem; the ERROR REPORT at the end of the message is that result, measured by the app. Use it as the evidence for GRA and LR. Do NOT list or repeat individual grammar/vocabulary errors yourself.\n\n'+
      'IELTS BAND DESCRIPTORS:\n'+
      'TR/TA: Band 7=covers all parts, clear position, ideas developed. Band 6=addresses parts but some inadequately. Band 5=partial, limited. Band 4=minimal.\n'+
      'CC: Band 7=logical, varied cohesion, good paragraphing. Band 6=mostly coherent. Band 5=some org. Band 4=incoherent.\n'+
      'LR: Band 7=flexible range, minor errors. Band 6=adequate. Band 5=limited. Band 4=basic.\n'+
      'GRA: Band 7=complex structures, frequent error-free. Band 6=mix. Band 5=frequent errors. Band 4=many errors.\n\n'+
      'SCORING RULES:\n- Components (TR, CC, LR, GRA): WHOLE numbers only, as in the official IELTS Writing marking — no X.5.\n- Overall = average of the 4, rounded the IELTS way (.25 → .5, .75 → next whole band). The app computes it from your components.\n- Do NOT write any numeric band score in band_description (the app shows the numbers next to your text).\n- Most students score 5-6. Band 7 = genuinely good. Band 8+ very rare.\n- Grammar errors → GRA ≤ 6. Basic vocab → LR ≤ 6.\n\n'+
      '[CONDITIONAL RULES — enforce strictly, do not overlook any]\n'+
      '1) LEXICAL RESOURCE & GRAMMAR — HARD LIMITS:\n'+
      '- TYPING SLIPS (counted in the ERROR REPORT as "typing slips"): IF more than 5 THEN cap LR at Band 5 and write in Vietnamese in criteria_notes.LR.why_not_higher_vi: "Sai chính tả trên 5 lỗi không thể đạt Band 6 tiêu chí Vocab". IF 1-5 THEN cap LR at Band 6. Never mention an individual typing slip.\n'+
      '- IF there are basic punctuation errors or failure to capitalize proper nouns (e.g. "zoom" instead of "Zoom", "google meet" instead of "Google Meet") THEN cap GRA at Band 6.\n'+
      '- Informal register, contractions, clichés (e.g. "nowadays"), informal phrasal verbs, repetition and unnatural collocations are already in the ERROR REPORT: let them lower LR / GRA as the calibration says.\n'+
      '- IF a body paragraph consists entirely of simple sentences without subordinating conjunctions (although, whereas, provided that) or relative clauses (which, who, that) THEN flag as "Lack of Grammatical Variety" and warn that Band 7 in GRA requires a mix of complex sentence structures.\n'+
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
      'SCORING CALIBRATION (IELTS public band descriptors — decide each criterion with these lines, then check the scores against them before returning):\n'+
      '- GRA 5: limited range; errors are FREQUENT — the same basic error type (subject-verb agreement, tense, plural -s, articles) repeats across paragraphs — and may cause some difficulty. GRA 6: a mix of simple and complex forms; errors occur but rarely impede. GRA 7: a variety of complex structures; FREQUENT error-free sentences; good control. If most sentences contain an error, GRA is not 6+.\n'+
      '- LR 5: limited range, mostly basic everyday words; noticeable errors in word choice or collocation. LR 6: adequate range; some less common words, used with some inaccuracy. LR 7: enough range for flexibility and precision; some less common items; only occasional collocation errors.\n'+
      '- CC 5: some organisation but weak progression; cohesive devices inadequate, inaccurate or OVERUSED. CC 6: coherent arrangement, but cohesion is faulty or MECHANICAL (template linkers — Firstly, Secondly, On the one hand, Moreover — opening most sentences or paragraphs). CC 7: clear progression; a range of cohesive devices, including reference and substitution, used flexibly.\n'+
      '- TR 5: addresses the task only partially; main ideas limited, not sufficiently developed, may be generalised or repetitive. TR 6: a relevant position, but some main ideas are inadequately developed or unclear. TR 7: a clear position throughout; main ideas extended and supported with specific reasons, examples or consequences.\n'+
      '- If the evidence fits a lower band\'s line, give the lower band. Meaning that is still clear is NOT a reason to raise a score: clarity alone is band 5–6. The anti-over-correction protocol only stops downgrades the evidence does not support.\n'+
      '[FEEDBACK FORMAT]\n'+
      'When any rule triggers, quote the exact sentence containing the error, use an arrow "=>", and give a precise, constructive correction based ONLY on the rules above. Keep the tone professional, direct and academic. Apply caps to the numeric scores accordingly — caps set the MAXIMUM; genuine weaknesses may score lower.\n\n'+
      'Return ONLY a JSON object with fields: scores(TR,CC,LR,GRA), overall, band_description, tr_comments(array of {paragraph_role,assessment_vi}), cc_feedback({assessment_vi, evidence:[{quote,note_vi}]}), criteria_notes(object with TR, CC, LR, GRA, each {why_not_higher_vi, strengths_vi:[1 item; CC: up to 2], improve_vi:[1 item; CC: up to 2]}), lexis_vi, repeated_errors_vi.\n'+
      '"why_not_higher_vi" (Vietnamese): the specific evidence from THIS text that keeps the criterion from the next band up, named against that band\'s descriptor. Maximum 2 short sentences.\n'+
      'OUTPUT BUDGET (keep it short): tr_comments "assessment_vi" = 1–2 sentences and NO quotation of the student\'s text and no English suggestion; do not write any general overall comment — the per-criterion notes are the only summary; do not repeat in one field what another field already says.\n'+
      'COHERENCE & COHESION report (cc_feedback + criteria_notes.CC): "cc_feedback.assessment_vi" = 2 sentences in the style of an IELTS band descriptor, describing THIS text: how logically information and ideas are organised and progress; the range of cohesive devices, including reference and substitution, and whether they are used flexibly, accurately, mechanically or over/under-used; whether paragraphing and the sequencing of ideas inside paragraphs work. "why_not_higher_vi" says what keeps CC from the next band. "evidence" = 3–4 items, each {quote: an exact SHORT quote (1–5 words, e.g. a linker or a reference phrase) from the text, note_vi: at most 15 Vietnamese words on what it does well or badly}. Do not list a linker twice.\n'+
      '[MINIMUM DEPTH — a strong essay still gets detailed feedback]\n'+
      'A high band is NEVER a reason to return short or empty feedback. Band 7 is not perfect: it still contains weak or unsupported examples, over-long sentences, and paragraphs that could be developed further. Praise alone is not useful feedback.\n'+
      '- ALWAYS return one tr_comments entry for EVERY paragraph of the response (Task 2: Opening, each Body, Conclusion. Task 1: Introduction, Overview, each Body — Task 1 has NO Conclusion), even when the paragraph is good: say specifically what works and what single change would strengthen it.\n'+
      '- "lexis_vi" (Vietnamese, 3–5 sentences): comment on the student\'s VOCABULARY LEVEL and COLLOCATIONS. Use the VOCABULARY DATA section (CEFR spread, dictionary-matched collocations, repeated basic words) as evidence and check it against the essay. Name 1–2 collocations the student used well (quote them), point out any unnatural word combination, and give 2–3 natural collocations the student could use for their OWN ideas in this essay (English collocation + Vietnamese meaning). Do not repeat items already listed in the ERROR REPORT.\n'+
      'TOKEN RULES for tr_comments — follow strictly to keep output short:\n'+
      '- Do NOT quote whole paragraphs. For each comment set "paragraph_role" to the paragraph label ONLY. Task 2: "Opening", "Body 1", "Body 2", "Body 3"... , or "Conclusion" (a 4-paragraph essay = Opening, Body 1, Body 2, Conclusion; a 5-paragraph essay = Opening, Body 1, Body 2, Body 3, Conclusion). Task 1: "Introduction", "Overview", "Body 1", "Body 2" (never "Conclusion" — see the Task 1 rules).\n'+
      '- "assessment_vi" is your comment on that paragraph: what works and the one thing to change. Do not quote the paragraph.';

    var errorsSystem='You are a strict IELTS Writing examiner. In this step you ONLY find the grammar errors and vocabulary problems in the student\'s text. You do not give scores and do not comment on structure, ideas or task response. Every item must quote directly from the text. Never invent examples.\n\n'+
      'The primary learning goal is improving GRAMMAR ACCURACY and VOCABULARY PRECISION sentence by sentence. Go through EVERY sentence of the WHOLE text (opening and conclusion included) and:\n'+
      '  (a) GRAMMAR: subject-verb agreement, tense inconsistency, article misuse (a/an/the), preposition errors, wrong word form (noun/verb/adjective confusion), missing or extra words, run-on sentences, comma splices, dangling modifiers, basic punctuation errors, failure to capitalise proper nouns (e.g. "zoom" for "Zoom"). Quote the wrong form, give the correct form, and explain in Vietnamese WHY it is wrong.\n'+
      '  (b) VOCABULARY: unnatural collocations (e.g. "do a mistake" for "make a mistake"; label type "collocation"), imprecise word choice, informal words or contractions (it\'s, don\'t) in formal writing, informal phrasal verbs ("look into", "get rid of"), the cliché "nowadays" when it is in the STUDENT\'S text (not merely in the task prompt), repetitive keywords that should be replaced by pronouns or synonyms (only when the repetition shows a lack of vocabulary; accept fixed technical terms), words that are close but not the best fit. Quote the original, suggest a more precise/natural/academic alternative, and explain in Vietnamese what the difference is.\n'+
      'NATURALNESS OVER COMPLEXITY: do NOT "upgrade" vocabulary that is already natural, accurate and an appropriate academic collocation (accept "heavy financial burden"; do not force "significant financial burden"). Correct only what is wrong, too informal, or noticeably repetitive.\n'+
      'TYPING SLIPS (misspellings, doubled letters or words such as "this this", words run together, missing or double spaces) are NEVER listed. Only count them and return the count in "typo_count".\n\n'+
      'Return ONLY a JSON object: {"typo_count": number, "gra_errors": [{"wrong","correct","explanation_vi","severity","type"}], "lr_issues": [{"original","better","explanation_vi","severity","type"}]}.\n'+
      '- "wrong" and "original" must be copied EXACTLY, character for character, from the student\'s text, and must be the SMALLEST span that contains the error (usually 2–6 words, never a whole sentence): the app finds and highlights them, and a quote that is not in the text is discarded.\n'+
      '- "correct" and "better" is ALWAYS a concrete replacement; an item without one is not reported.\n'+
      '- "explanation_vi": at most 25 Vietnamese words, saying why it is wrong or what is better.\n'+
      '- "severity": "error" (a real mistake — wrong grammar, word, collocation, register or punctuation; never a typing slip) or "upgrade" (correct, but could be more precise, natural or academic). "type", one of: subject_verb_agreement, verb_tense, verb_form, plural_noun, article, preposition, word_form, word_order, missing_word, sentence_structure, punctuation, capitalisation, word_choice, collocation, register, repetition.\n'+
      '- In each array list EVERY "error" first, in text order; then add at most 3 "upgrade" items in total (the best ones only). Never invent an error and never label an upgrade as an error. One mistake = one item: do not report the same words twice, and do not report the same mistake in both arrays.\n'+
      '- Put grammar items in "gra_errors" and vocabulary items in "lr_issues".\n'+
      'COMPLETENESS: report EVERY grammar error and EVERY vocabulary problem in the whole text, in the order they appear — no upper limit, never stop at a fixed number, never keep some back for a later attempt. The student corrects the text from this ONE report: an error that is in the text but missing here must not turn up as a "new" error when the same text is checked again. Report only real errors — if a paragraph has few, report few; never add items to fill a quota.';

    // Strip HTML tags from question (may contain <b>,<i> from rich text editor)
    var tmp=document.createElement('div'); tmp.innerHTML=question;
    var cleanQ=(tmp.textContent||tmp.innerText||question).replace(/\s+/g,' ').trim();

    var isTask1 = payload.taskType === 'task1';
    // Word count thresholds — Task 1: 150 words, Task 2: 250 words
    // Use teacher's custom minWords if set, otherwise IELTS standard
    var minWords = (payload.minWords && payload.minWords > 0) ? payload.minWords
                 : (isTask1 ? 150 : 250);
    var wc = AW.wordCount(text);
    var wcLabel = payload.minWords && payload.minWords > 0
      ? 'teacher minimum ('+minWords+' words)'
      : 'IELTS minimum for Task '+(isTask1?'1 (150 words)':'2 (250 words)');

    // Build word count instruction for the AI
    var wcInstruction = '\n\nWORD COUNT: This response is '+wc+' words. The '+wcLabel+' is '+minWords+' words. '+
      (wc >= minWords
        ? 'Word count is SUFFICIENT. Do NOT penalize or mention word count in your feedback — it meets the requirement.'
        : 'Word count is BELOW the minimum. '+
          (wc < Math.floor(minWords*0.6)
            ? 'Cap TR/TA at Band 4 (severely underlength — below 60% of minimum).'
            : 'Cap TR/TA at Band 5 (underlength — between 60–99% of minimum).')+
          ' Mention in the Task Response note (criteria_notes.TR) that the response is too short ('+wc+'/'+minWords+' words).');

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
        '\n\n=== TASK 1 STRUCTURE (these rules OVERRIDE the essay rules above wherever they differ) ===\n'+
        'A Task 1 report has FOUR parts:\n'+
        '1. Introduction — paraphrases what the chart/diagram/map shows (no opinion, no data details).\n'+
        '2. Overview — the main trends / most striking features in general terms, usually without specific figures. It is normally the 2nd paragraph; it is sometimes placed at the END instead — that is less common but fully acceptable: never penalise an overview at the end, label that paragraph "Overview".\n'+
        '3. Body 1 and 4. Body 2 — the key features with accurate supporting data, grouped logically, with comparisons.\n'+
        'There is NO Conclusion in Task 1:\n'+
        '- Never ask for, suggest or praise a conclusion; never criticise the absence of one; never use "Conclusion" as a paragraph_role. Do not tell the student to "add a concluding sentence/paragraph" — if the main features are not summarised, the advice is to ADD/IMPROVE THE OVERVIEW.\n'+
        '- If the last paragraph summarises the main trends, it IS the overview (label it "Overview").\n'+
        '- If the last paragraph gives an opinion, reasons, predictions or information not shown in the visual, flag it as irrelevant for Task 1 (TA).\n'+
        '- No clear overview anywhere → cap TA at Band 5 (official descriptor) and say so in Vietnamese. An overview full of specific numbers → advise moving the figures to the body paragraphs.\n'+
        '- The Task 2 rules about thesis statements, position, thesis–topic alignment, "Inconsistent Position" and conclusions do NOT apply to Task 1. Coherence & Cohesion for Task 1: logical grouping of the data, clear progression Introduction → Overview → Body 1 → Body 2, comparison language and referencing.\n'+
        '- In tr_comments return one entry each for Introduction, Overview, Body 1, Body 2 (in the order the student wrote them).'+
        wcInstruction+
        attemptNote;
    } else {
      userMessage =
        'Grade this IELTS Academic Writing Task 2 essay.\n\n'+
        'TASK PROMPT: '+cleanQ+'\n\n'+
        'STUDENT ESSAY TO GRADE:\n---\n'+text+'\n---\n\n'+
        'Task Response score MUST assess how directly the essay addresses the given task prompt. If the essay goes off-topic or misses the task, TR ≤ 5.'+
        wcInstruction+
        attemptNote;
    }
    // Teacher's context rules override default IELTS strictness
    if (payload.aiNotes && payload.aiNotes.trim()) {
      userMessage += '\n\n=== TEACHER\'S GRADING RULES (HIGHEST PRIORITY — these OVERRIDE the default IELTS strictness above) ===\n'+
        payload.aiNotes.trim()+
        '\n\nYou MUST follow these teacher rules. Do NOT flag, mark, or deduct points for anything the teacher has explicitly allowed or told you to ignore. Only report errors that remain genuine problems given these rules. This keeps feedback appropriate for the class context and avoids overwhelming the student with irrelevant corrections.';
    }
    var wt = payload.writingType || 'full_essay';
    if (wt === 'paragraph') {
      userMessage = userMessage.replace(wcInstruction, '\n\nWORD COUNT: ' + wc + ' words. Do not cap or penalise for length.') +
        '\n\n=== TASK FORMAT: PARAGRAPH PRACTICE (overrides everything above about essay structure) ===\n'+
        'The teacher set paragraph practice. The response is one or more STANDALONE paragraphs, not an essay. Do NOT label paragraphs Opening, Body or Conclusion, do NOT expect an introduction, thesis or conclusion, and do NOT assess Task Response or Task Achievement.\n'+
        'Assess only: Coherence & Cohesion WITHIN each paragraph (topic sentence, development and support, logical order, linking), Lexical Resource, and Grammatical Range & Accuracy.\n'+
        'Return "scores" with CC, LR and GRA only — no TR. "tr_comments": one entry per paragraph with "paragraph_role" = "Paragraph 1", "Paragraph 2"…, about how well that paragraph is built. "criteria_notes": CC, LR and GRA only.';
    } else if (wt === 'sentences') {
      userMessage = userMessage.replace(wcInstruction, '') +
        '\n\n=== TASK FORMAT: SENTENCE PRACTICE (overrides everything above) ===\n'+
        'The teacher set sentence practice. The response is a set of SEPARATE sentences, not a paragraph or an essay. Do NOT treat any sentence as an opening, a body or a conclusion; do NOT comment on structure, coherence, cohesion, task response or development; and do NOT give any band score.\n'+
        'Check every sentence for grammar and vocabulary only. Return: "scores": {} (empty), "gra_errors", "lr_issues", "tr_comments": [] (empty), "cc_feedback": {} (empty), "criteria_notes" with LR and GRA only (leave why_not_higher_vi empty), and "band_description": "Sentence practice".';
    }
    // rules about task response / coherence only add input tokens (and confusion) when those criteria are not graded
    if (wt !== 'full_essay') {
      var a2 = systemInstruction.indexOf('2) TASK RESPONSE'), a3 = systemInstruction.indexOf('3) COHERENCE & COHESION'),
          a4 = systemInstruction.indexOf('[ANTI-OVER-CORRECTION');
      if (a2 > 0 && a3 > a2 && a4 > a3) systemInstruction = systemInstruction.slice(0, a2) + (wt === 'paragraph' ? systemInstruction.slice(a3) : systemInstruction.slice(a4));
    }
    // ---- STEP 1: Gemini lists every grammar / vocabulary error (nothing else) ----
    var userA = 'TASK PROMPT: '+cleanQ+'\n\nSTUDENT TEXT TO CHECK:\n---\n'+text+'\n---\n'+
      (wt === 'sentences' ? '\nThe text is a set of SEPARATE practice sentences: check every sentence.\n' : '');
    if (payload.aiNotes && payload.aiNotes.trim()) {
      userA += '\n=== TEACHER\'S RULES (HIGHEST PRIORITY) ===\n'+payload.aiNotes.trim()+
        '\nDo NOT report anything the teacher has explicitly allowed or told you to ignore.\n';
    }
    var promptA = errorsSystem+'\n\n'+userA;
    var a = await runStep1(promptA, geminiKey);
    cleanErrors(a, payload);

    // sentence practice: no band, so no scoring step at all
    if (wt === 'sentences') {
      return { scores:{}, band_description:'Sentence practice', tr_comments:[], cc_feedback:{}, criteria_notes:{},
               typo_count:a.typo_count, gra_errors:a.gra_errors, lr_issues:a.lr_issues };
    }

    // ---- STEP 2: Gemini scores, with the measured error report as evidence ----
    var promptB = systemInstruction+'\n\n'+userMessage+'\n\n'+errorReport(a, wc);
    if (payload.vocabSummary && payload.vocabSummary.trim()) {
      promptB += '\n\n=== VOCABULARY DATA (for Lexical Resource reference) ===\n' + payload.vocabSummary.trim();
    }
    var r = await callAI(promptB, geminiKey);
    r.gra_errors = a.gra_errors; r.lr_issues = a.lr_issues; r.typo_count = a.typo_count;
    return r;
  }

  /* One AI call with the whole fallback chain: Gemini models → Groq → Gemini again. */
  async function callAI(prompt, geminiKey) {
    try { return await callAIOnce(prompt, geminiKey); }
    catch (e) {   // a garbled reply is usually a one-off: ask once more before bothering the student
      if (/Lỗi định dạng|Lỗi đọc kết quả/.test((e && e.message) || '')) return await callAIOnce(prompt, geminiKey);
      throw e;
    }
  }
  async function callAIOnce(prompt, geminiKey) {
    var g = await geminiPass(geminiKey, prompt);
    if (g.raw) return parseAiJson(g.raw, 'AI');

    // -- Groq fallback: every Gemini model was busy, over quota or too slow --
    if (window.AW && AW.toast) AW.toast('⏳ Gemini đang bận — đang chuyển sang AI dự phòng…', 'err', 4000);
    var groqKey = (window.AW && AW.groqKey) ? AW.groqKey.get() : '';
    if (!groqKey) groqKey = await requestGroqKey(g.err);   // rejects if the student cancels
    try {
      return await gradeWithGroq(groqKey, prompt);
    } catch (groqErr) {
      if (window.AW && AW.toast) AW.toast('⏳ Groq cũng gặp sự cố — đang thử lại Gemini lần cuối…', 'err', 3500);
      await new Promise(function (r) { setTimeout(r, 6000); });   // congestion is short-lived
      var g2 = await geminiPass(geminiKey, prompt);
      if (g2.raw) return parseAiJson(g2.raw, 'AI');
      throw new Error('AI đang ngẽn: cả Gemini và Groq đều không phản hồi. ' +
        'Đây là sự cố tạm thời của dịch vụ AI — không phải lỗi ứng dụng. ' +
        'Vui lòng đợi 2–3 phút rồi bấm lại. Bài viết của bạn vẫn an toàn.');
    }
  }

  /* Step 1 is remembered: if step 2 fails and the student presses the button again,
     or the same text is graded twice, the SAME error list is used (no second AI call,
     and no "new" errors appearing in an unchanged text). */
  var _step1 = { p: '', v: null };
  async function runStep1(prompt, key) {
    if (_step1.p === prompt && _step1.v) return JSON.parse(JSON.stringify(_step1.v));
    var a = await callAI(prompt, key);
    _step1 = { p: prompt, v: JSON.parse(JSON.stringify(a)) };
    return a;
  }

  /* The error list as numbers the scorer can use: counts, density, types, examples. */
  function errorReport(a, wc) {
    var real = function (arr) { return (arr || []).filter(function (e) { return e.severity !== 'upgrade' && !e.unlocated; }); };
    var g = real(a.gra_errors), l = real(a.lr_issues), per = function (n) { return (n / Math.max(wc, 1) * 100).toFixed(1); };
    var byType = function (arr) {
      var c = {}; arr.forEach(function (e) { var k = e.type || 'other'; c[k] = (c[k] || 0) + 1; });
      var ks = Object.keys(c).sort(function (x, y) { return c[y] - c[x]; });
      return { c: c, ks: ks, txt: ks.length ? ks.map(function (k) { return k + ' ' + c[k]; }).join(', ') : 'none' };
    };
    var tg = byType(g), tl = byType(l);
    var ex = function (arr, t) {
      return t.ks.slice(0, 3).map(function (k) {
        return arr.filter(function (e) { return (e.type || 'other') === k; }).slice(0, 2).map(function (e) { return '  ' + k + ': "' + (e.wrong || e.original) + '" → "' + (e.correct || e.better) + '"'; }).join('\n');
      }).join('\n');
    };
    return '=== ERROR REPORT (step 1, measured by the app — do not list these errors again) ===\n' +
      'Words: ' + wc + '. Typing slips: ' + (a.typo_count || 0) + '.\n' +
      'Grammar errors: ' + g.length + ' (' + per(g.length) + ' per 100 words). By type: ' + tg.txt + '.\n' +
      'Vocabulary errors: ' + l.length + ' (' + per(l.length) + ' per 100 words). By type: ' + tl.txt + '.\n' +
      (g.length || l.length ? 'Examples of the most frequent types:\n' + [ex(g, tg), ex(l, tl)].filter(Boolean).join('\n') + '\n' : '') +
      'Approximate guide (your judgement and the band descriptors decide): GRA — about 6 or more grammar errors per 100 words, or the same basic error type repeated across paragraphs, points to band 5 or below; about 3–6 points to 5–6; under about 3 together with varied complex sentences allows 6–7. LR — about 4 or more vocabulary errors per 100 words points to band 5 or below; about 2–4 points to 5–6; under 2 with a good range allows 6–7. Judge the RANGE of vocabulary and grammar yourself; the report measures accuracy only.';
  }

  var GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'];
  var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  // Gemini 3.x: do NOT override temperature/topK/topP (causes empty responses)
  function buildGenerationConfig(modelName) {
    var cfg = { candidateCount:1, maxOutputTokens:16000, responseMimeType:'application/json' };
    if (modelName.indexOf('gemini-3') === 0) cfg.thinkingConfig = { thinkingLevel:'minimal' };
    else { cfg.temperature = 0.1; cfg.topK = 1; cfg.topP = 0.1; }
    return cfg;
  }

  /* One pass over the Gemini models → { raw } or { err }. Each model has its
     own quota and capacity, so a busy, rate-limited, slow, retired or empty
     one is skipped — it used to end the pass, which sent whole classes to the
     Groq fallback while the other models were free. A wrong key or no network
     throws at once: no other model would fix that.                         */
  async function geminiPass(geminiKey, prompt) {
    var err = '';
    for (var mi = 0; mi < GEMINI_MODELS.length; mi++) {
      var modelName = GEMINI_MODELS[mi], resp;
      var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, 60000);
      try {
        resp = await fetch(GEMINI_BASE + modelName + ':generateContent?key=' + geminiKey, {
          method:'POST', headers:{'Content-Type':'application/json'}, signal: ctrl.signal,
          body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig: buildGenerationConfig(modelName) })
        });
      } catch (e) {
        if (e && e.name === 'AbortError') { err = 'overloaded:timeout'; continue; }
        throw new Error('network: ' + ((e && e.message) || 'failed to fetch'));
      } finally { clearTimeout(timer); }

      if (resp.ok) {
        var data = await resp.json().catch(function(){ return {}; });
        var parts = (((data.candidates||[])[0]||{}).content||{}).parts;
        var raw = parts && parts[0] ? parts[0].text : '';
        if (raw) return { raw: raw };
        err = 'empty'; continue;
      }
      var body = await resp.json().catch(function(){ return {}; });
      var msg = (body.error && body.error.message) || String(resp.status);
      if (resp.status === 401 || resp.status === 403 || /api[ _]key/i.test(msg)) throw new Error('Gemini error: API key — ' + msg);
      if (resp.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(msg)) { err = 'quota:' + resp.status; continue; }
      if (resp.status >= 500) { err = 'overloaded:' + resp.status; continue; }
      if (resp.status === 404 || resp.status === 400 || /no longer available|deprecated|not found/i.test(msg)) { err = msg; continue; }
      throw new Error('Gemini error: ' + msg);
    }
    return { err: err };
  }

  // The JSON object inside an AI reply (it may be wrapped in ``` or stray text)
  function parseAiJson(raw, who) {
    var clean = String(raw).replace(/<thinking>[\s\S]*?<\/thinking>/gi,'')
                   .replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
    var si = clean.indexOf('{'), ei = clean.lastIndexOf('}');
    if (si === -1 || ei <= si) throw new Error('Lỗi định dạng: ' + who + ' không trả về JSON hoàn chỉnh. Vui lòng thử lại.');
    var obj = parseLoose(clean.substring(si));
    if (!obj) {
      // keep the evidence: what the AI really sent (the student only sees "format error")
      try { console.warn('[grader] unreadable AI JSON — length', clean.length, '\nSTART:', clean.slice(0, 400), '\nEND:', clean.slice(-400)); } catch (e) {}
      throw new Error('Lỗi đọc kết quả từ ' + who + ' (JSON sai cú pháp). Vui lòng thử lại.');
    }
    return normaliseScores(obj);
  }

  /* JSON.parse, then two repairs for the usual AI slips: trailing commas, and a reply cut off
     in the middle (keep everything up to the last complete item and close the brackets). */
  function parseLoose(t) {
    var ei = t.lastIndexOf('}');
    if (ei < 0) return null;
    var whole = t.substring(0, ei + 1);
    try { return JSON.parse(whole); } catch (e) {}
    try { return JSON.parse(whole.replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
    var stack = [], inStr = false, esc = false, cuts = [];
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') stack.push('}');
      else if (c === '[') stack.push(']');
      else if (c === '}' || c === ']') { stack.pop(); if (stack.length) cuts.push([i, stack.slice()]); }
    }
    for (var k = cuts.length - 1, n = 0; k >= 0 && n < 60; k--, n++) {
      var head = t.substring(0, cuts[k][0] + 1) + cuts[k][1].slice().reverse().join('');
      try { return JSON.parse(head.replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
    }
    return null;
  }

  // requestGroqKey: shows popup asking student to enter their Groq key.
  // Returns a Promise<string> that resolves when key is submitted, rejects on cancel.
  function requestGroqKey(geminiErrContext) {
    return new Promise(function(resolve, reject) {
      // Remove any existing popup
      var old = document.getElementById('aw-groq-popup');
      if (old) old.remove();

      var popup = document.createElement('div');
      popup.id = 'aw-groq-popup';
      popup.style.cssText =
        'position:fixed;inset:0;background:rgba(16,34,46,.7);z-index:9990;'+
        'display:flex;align-items:center;justify-content:center;padding:20px;font-family:var(--aw-font-body,system-ui)';

      popup.innerHTML =
        '<div style="background:#fff;border-radius:16px;max-width:460px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden">'+
          '<div style="background:#E8730C;color:#fff;padding:16px 20px">'+
            '<b style="font-size:1rem">⚡ Chuyển sang Groq AI</b>'+
          '</div>'+
          '<div style="padding:20px 22px">'+
            '<p style="margin:0 0 10px;font-size:.92rem;color:#1F2933;line-height:1.5">'+
              'Gemini đã hết lượt miễn phí. Bài làm của bạn sẽ được chấm bằng <b>Groq AI</b> — '+
              'chất lượng tương đương, hoàn toàn miễn phí.'+
            '</p>'+
            '<p style="margin:0 0 14px;font-size:.83rem;color:#4B5075;line-height:1.5">'+
              'Lấy Groq API key miễn phí (30 giây): '+
              '<a href="https://console.groq.com/keys" target="_blank" '+
                'style="color:#E8730C;font-weight:700">console.groq.com/keys</a>'+
              ' → Sign in → Create API Key → Copy.'+
            '</p>'+
            '<div style="position:relative;margin-bottom:6px">'+
              '<input id="aw-groq-key-input" type="password" placeholder="gsk_..." '+
                'style="width:100%;padding:11px 44px 11px 12px;border:1.5px solid #CBD5E0;'+
                'border-radius:10px;font-size:.95rem;box-sizing:border-box;outline:none">'+
              '<button id="aw-groq-show" type="button" '+
                'style="position:absolute;right:10px;top:50%;transform:translateY(-50%);'+
                'background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:.78rem">show</button>'+
            '</div>'+
            '<label style="display:flex;align-items:center;gap:7px;font-size:.8rem;color:#4B5075;margin-bottom:16px;cursor:pointer">'+
              '<input type="checkbox" id="aw-groq-save" checked style="width:15px;height:15px">'+
              'Lưu key vào thiết bị này (không cần nhập lại lần sau)'+
            '</label>'+
            '<div style="display:flex;gap:8px">'+
              '<button id="aw-groq-cancel" '+
                'style="flex:1;padding:11px;border:1px solid #CBD5E0;border-radius:10px;'+
                'background:#fff;cursor:pointer;font-size:.88rem;color:#4B5075">Cancel</button>'+
              '<button id="aw-groq-submit" '+
                'style="flex:2;padding:11px;border:none;border-radius:10px;'+
                'background:#E8730C;color:#fff;cursor:pointer;font-size:.92rem;font-weight:700">'+
                'Grade with Groq</button>'+
            '</div>'+
          '</div>'+
        '</div>';

      document.body.appendChild(popup);

      // show/hide toggle
      var inp = document.getElementById('aw-groq-key-input');
      document.getElementById('aw-groq-show').onclick = function() {
        inp.type = inp.type==='password' ? 'text' : 'password';
        this.textContent = inp.type==='password' ? 'show' : 'hide';
      };
      inp.focus();
      inp.onkeydown = function(e){ if(e.key==='Enter') document.getElementById('aw-groq-submit').click(); };

      document.getElementById('aw-groq-cancel').onclick = function() {
        popup.remove();
        reject(new Error('Sinh viên huỷ nhập Groq key. Bài chưa được chấm.'));
      };

      document.getElementById('aw-groq-submit').onclick = function() {
        var key = (inp.value||'').trim();
        if (!key || key.length < 10) {
          inp.style.borderColor='#E53E3E';
          inp.placeholder='Nhập key hợp lệ (bắt đầu bằng gsk_...)';
          return;
        }
        if (document.getElementById('aw-groq-save').checked && window.AW && AW.groqKey) {
          AW.groqKey.set(key); // persist for future sessions
        }
        popup.remove();
        resolve(key);
      };
    });
  }

  /*-- gradeWithGroq: call Groq API with same prompt, return normalised result --*/
  async function gradeWithGroq(groqKey, prompt) {
    if (!groqKey) throw new Error('Không có Groq API key.');
    // Current stable Groq models (Aug 2026) — ordered by quality/speed
    var GROQ_MODELS = [
      'openai/gpt-oss-120b', // primary — best quality
      'qwen/qwen3.6-27b',    // fallback 1 — balanced
      'openai/gpt-oss-20b',  // fallback 2 — fast, cheap
    ];
    var lastErr = '';
    for (var gmi = 0; gmi < GROQ_MODELS.length; gmi++) {
      var groqModel = GROQ_MODELS[gmi];
      var groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+groqKey},
        body: JSON.stringify({
          model: groqModel,
          messages:[{role:'user', content:prompt}],
          temperature:0.1, max_tokens:8000,
          response_format:{type:'json_object'}
        })
      });
      if (groqResp.ok) {
        var groqData = await groqResp.json();
        var groqRaw  = ((groqData.choices||[])[0]||{}).message;
        groqRaw = groqRaw ? groqRaw.content : '';
        if (!groqRaw) throw new Error('Groq trả về rỗng. Thử lại sau.');
        return parseAiJson(groqRaw, 'Groq');
      }
      var groqErr = await groqResp.json().catch(function(){return{};});
      lastErr = (groqErr.error && groqErr.error.message) || String(groqResp.status);
      var isModelErr = groqResp.status===404 || lastErr.indexOf('decommission')!==-1 ||
                       lastErr.indexOf('deprecated')!==-1 || lastErr.indexOf('not found')!==-1 ||
                       lastErr.indexOf('model_not_found')!==-1;
      if (groqResp.status===401 || lastErr.indexOf('invalid')!==-1 || lastErr.indexOf('auth')!==-1)
        throw new Error('Groq key không hợp lệ. Kiểm tra lại và thử nhập key khác.');
      if (groqResp.status===429)
        throw new Error('groq:quota:' + lastErr); // signal for Gemini retry
      if (!isModelErr) throw new Error('Groq error: ' + lastErr);
      // deprecated/not-found model → try next silently
    }
    throw new Error('Groq error: ' + lastErr);
  }

  /* After the AI: the task format decides what is scored; one mistake is one
     item; a quote that is not in the text is flagged (the app cannot mark it). */
  function finish(r, payload) {
    var wt = payload.writingType || 'full_essay';
    r.writing_type = wt;
    if (wt === 'sentences') { r.scores = null; r.overall = 'Done'; r.tr_comments = []; r.cc_feedback = {}; }
    else if (wt === 'paragraph' && r.scores) { delete r.scores.TR; normaliseScores(r); }
    cleanErrors(r, payload);
    return r;
  }
  function cleanErrors(r, payload) {
    var flat = function (t) { return String(t || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); };
    var text = flat(payload.writing);
    r.typo_count = parseInt(r.typo_count, 10) || 0;
    [['gra_errors', 'wrong', 'correct'], ['lr_issues', 'original', 'better']].forEach(function (f) {
      var seen = {};
      r[f[0]] = (r[f[0]] || []).filter(function (e) {
        if (!e || !e[f[1]] || !e[f[2]]) return false;            // no concrete replacement = nothing to teach
        if (e.type === 'spelling') return false;                  // typing slips are counted, never listed
        if (flat(e[f[1]]).replace(/ /g, '') === flat(e[f[2]]).replace(/ /g, '')) return false;   // spacing-only "errors"
        var k = flat(e[f[1]]) + '→' + flat(e[f[2]]);
        if (seen[k]) return false;
        seen[k] = 1;
        e.unlocated = text.indexOf(flat(e[f[1]])) < 0;
        return true;
      });
    });
    return r;
  }
  AW.gradeFinish = finish;   // used by tests/grader.check.js

  // Public API
  AW.grade          = function (payload, key) { return gradeWithGemini(payload, key).then(function (r) { return finish(r, payload); }); };   // Gemini → Groq fallback
  AW.gradeGroq      = gradeWithGroq;     // direct Groq grading
  AW.gradeNormalise = normaliseScores;   // used by test.html

})(window.AW = window.AW || {});
