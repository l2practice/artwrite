# Credits

The scoring logic of `aw-grader.js` is the teacher's own (the original ArticuWrite prompt: band one-liners, scoring rules, conditional rules for LR/GRA, TR and CC, the anti-over-correction protocol and the verification before any 6.0). Nothing from other grading repositories or services is part of it.

Two technical ideas in the grading pipeline came from **AhmedSobhy01/bandcheck** (MIT licence, https://github.com/AhmedSobhy01/bandcheck): cutting the text into numbered sentences before marking so that every error points at a sentence, and asking the model for structured (schema) output. No text or code was copied.

```
MIT License

Copyright (c) 2026 Ahmed Sobhy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
