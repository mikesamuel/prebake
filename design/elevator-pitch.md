# Elevator Pitch

Dynamic languages like JavaScript don't need a compile phase but benefit from one.

Consider:

```js
// To import a generated file, you need to invoke a separate build tool.
import { generatedApi } from '../../../bazel-out/src/js/myproject/foo';

// If the code generator is written in JS, this won't work alongside a
// strict Content-Security-Policy.
import { codeGenerator } from './code-generator';
const usefulFunction = new Function('x', codeGenerator('./file-in-domain-specific-language'));
// Also, this is opaque to static analysis tools.

// Legacy code does this a lot.  Incompatible with Content-Security-Policy.
const global = new Function('return this')();

// Language introspection doesn't let a program ask a tool to "lint me!"
// even though "me" is well-defined at runtime.
import { linter } from 'linter';
linter.lint(thisProgram);
```

Prebake takes in a highly dynamic program and produces a reliable, static system.

| Pros of Dynamic languages | Cons |
| ---- | ---- |
| Can rewrite themselves to adapt to their environment | XSS: Attackers who control critical strings can subvert the program to their ends. |
| Can interoperate with other languages via runtime code generators | Static analysis is missing important parts of the program |
| Introspection & reflection allow meta-programming | Code quality tools (linters, bundlers, test coverage) resort to heuristics (and lots of hand-tuning) to find sources since they can't introspect over program source. |

## Goal

Prebake aims to preserve the pros while mitigating the cons and bring the benefits of
compile phases to project teams that are too small to dedicate resources to maintaining
a build system.

Prebake preserves the pros while mitigating the cons by running critical dynamic code early.

*   Dynamic operations happen before untrusted strings reach the system, so avoid code injection.
*   Prebake evaluates code generators early, and can callout to an external code generator
    bringing generated source into the set available to static analysis tools.
*   Prebake provides additional, powerful language introspection APIS allowing the program to run
    its own code quality tools on itself.  These APIs evaporate before untrusted inputs reach
    the system so are not exploitable.

Prebake aims to blur the distinction between program and build system so small teams need not
dedicate resources to learning and maintaining a myriad of external tools.  Normal JS
techniques like `import`, code complete, and interactive debugging should be sufficient to
interact with, and diagnose problems with code quality tools.

