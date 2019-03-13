# Prebake

# Motivation

## Getting the benefits of a well-defined build pipeline early.

Teams that have a well-defined build process can hook in tools that catch
problems early, guide developers (especially newer team members) away from
problems (like error-prone APIs) that have bitten team members in the past,
and towards good practices.

Integrated with CI and CD systems, they can loop in a specialist to get
the right eyes on tricky code.

This makes build system hooks the ideal place for a security team to
put in controls to help quick moving development teams stick to security
guidelines and know when to adapt them to changing requirements.

But many quick moving development teams can't afford to dedicate a
team member to maintaining build scripts and teaching other team
members to use and maintain them.  Worst case, when that team member
goes on vacation and they run into a thorny problem, the team has to
choose between moving slower or abandoning the build system.

This contributes to build systems being used not at all, or added
towards the end of a product lifecycle, when the code controls are
too late to do anything other than complain about what's now legacy
code.

Hypothesis: to bring the benefits of build systems to small organizations
that can't dedicate a build maintainer, it is sufficient to allow build
system functions be initiated by user code without stepping out of the
JS that developers know into BUILD or scripting languages that need to
replicate information already present in the program's source

Imagine if this worked:

```js
// An instrumented runtime keeps track of who imports whom.
import from './src/foo';
// A long-lived process will generate JS from DSL on demand
// the way a good IDE does.
import default as fooTemplate from './src/templates/foo.handlebars.js';

function main() {
  addEventListener('programWhole', () => {
    // Grab set of modules and run analyzers.
    ...
    // Look at module import graph and generate a list of not-yet-reviewed
    // uses of error-prine APIs that can be flagged when the PR makes it into
    // master.
    ...
    // Produce extra artifacts for resource integrity checks
    ...
    // Merge all modules loaded into a single dist/production-bundle.js
    ...
  });
}
```

Hopefully, by treating an explicit build step as an optional
optimization step the team can develop their code alongside controls
that surface the concerns of specialists like security blue-teamers on
an ongoing basis, and later in the development process add more build
machinery later when things like shipped code size become critical.


## Eval, The Good Parts.

> ### `eval` is Evil
>
> The `eval` function is the most misused feature of JavaScript. Avoid it.
>
> -- <cite>Douglas Crockford, "JavaScript: The Good Parts"</cite>

`eval` and its friend `new Function` are problematic because, too
often, an attacker can turn it against the application.

Most code avoids `eval`, but JS programs are no longer small, and
self-contained as they were when Crock wrote that.

If one module uses `eval`, even if it's as simple as
[`Function('return this')()`][core-js-example] to get a handle to the
global object then `eval` has to work.

This prevents the use of security measures like:

*  [Content-Security-Policy](https://csp.withgoogle.com/docs/index.html)
*  `node --disallow_code_generation_from_strings`

which turn off `eval` globally.

# Analysis

### Why do responsible programmers `eval`?

Any solution to the `eval` problem has to acknowledge that there are legitimate
use cases.

JavaScript is a
[glue language](https://en.wikipedia.org/wiki/Scripting_language#Glue_languages)
so it's unsurprising that JavaScript programmers need the language to
adapt to the environment.  Generating code may be the only way to:

*  Connect code to an external system.  For example, querying a
   database for its metadata and creating `class`es for each table.
*  Compile code in a [domain specific language][], like HTML templates,
   to JavaScript functions.

### Checking uses of `eval`

Some proposals like
[Trusted Types](https://wicg.github.io/trusted-types/dist/spec/#string-compilation)
aim to make it easier to confidently use `eval` safely by requiring
developers to be explicit about which strings are safe to load as code in
a way that blue-teamers can double check.

It's going to take some time for library code to change to take that into account
though.

### What distinguishes "good" `eval`?

We should seek to preserve the aspects of JavaScript's dynamism that
allow JavaScript programs to adapt to their environment without
preserving those that leave them vulnerable to attacker-controlled
strings.

The legitimate use cases I've seen all have the property that they
could happen before the system starts processing untrusted inputs.

[Ad-hoc reporting](https://www.techopedia.com/definition/30294/ad-hoc-reporting)
is important but not, IMO, a good use of `eval`.  It involves executing equations
reached over the network, and careful library code can do that efficiently.
After discussing ["The Node Security Roadmap"](https://nodesecroadmap.fyi/chapter-2/what-about-eval.html),
Math.js [got rid of all uses of `eval`](https://github.com/josdejong/mathjs/issues/1019#issuecomment-367289278).

### Unnecessary but safe uses of dynamic code loading in legacy code.

Some widely used legacy modules dynamically load code despite their being
better alternatives.  Adoption will be slow unless those are handled transparently.

For example:

*  [lodash](https://github.com/lodash/lodash/blob/c541e4ccdc22413eed96572acdce3b0b5fe0cb61/.internal/root.js#L7)
   (20.7 downloads/week) and
   [core-js](https://github.com/zloirock/core-js/blob/8a36f326ec636ebe8789dbbb8b8006d527d9882a/packages/core-js/internals/global.js#L5)
   (17.3M downloads/week) uses `Function('return this')()` to get a handle to the global object.
*  [depd](https://github.com/dougwilson/nodejs-depd/blob/6d59c85d093092e65ec77033576417d743079fa0/index.js#L413-L433)
   (9.9M downloads/week)
   and [promise](https://github.com/then/promise/issues/150) (7.8M downloads/week)
   use `new Function` to create function wrappers with the same `.length` to meet
   strict backwards compatibility constraints.
   Proxies would work, but only on modern JS engines and there are performance
   concerns.


# Proposal

A *Prebakery* takes a set of JS modules, runs `eval` and `new Function` early,
and

*  emits an equivalent[#caveat-not-equivalent](*) JavaScript program that does not depend
   on `eval` and `new Function`
*  and reports which uses it could not precompute.

The prebakery is written entirely in JavaScript so can run anywhere that the JS program that
it hoists could.


## Rejected Alternatives

### Macros

Macro systems are widely discussed in PL literature and an elegant way to assume some
build system functions in languages like [Clojure](https://clojure.org/reference/macros).

Any macro system would not address existing uses of string->code operators like `eval` and
`Function` (See discussion of "legacy" code above).

The proposed prebakery could probably interoperate with
[babel-plugin-macros](https://github.com/kentcdodds/babel-plugin-macros).

> babel-plugin-macros defines a standard interface for libraries that
> want to use compile-time code transformation without requiring the
> user to add a babel plugin to their build system


## Design and interface

We want to preserve semantics where possible.

Our end goal is to have `eval` and `Function` no longer needed.
Functions that definitely use these should be *moot* by the time
the system opens up to untrusted inputs.

Preserving semantics perfectly does not seem possible, so we will bite the
bullet and allow that order of execution may change in predictable ways.

<a name="caveat-not-equivalent"></a>

**Caveat**: Semantics may differ in that the initializers for clearly
marked declarations and expressions that depend on clearly marked
declarations may execute before those that are/do not.

Some functions may use *moot* functions if they're available but
not in all possible code-paths.  We will call these functions *eager*.

Let's define:

<dl>
  <dt>moot</dt>
  <dd>a declaration is moot if the program should not need it to function
  by the time untrusted input could reach it.</dd>
  <dt>eager</dt>
  <dd>a function is eager if it should run early where possible, but may not in
  all cases.</dd>
  <dt>early</dt>
  <dd>either eager or early</dd>
  <dt>prebakery</dt>
  <dd>a code preprocessor that takes a program and returns a program that is
  functionally equivalent (see caveat above) but which contains no references to
  moot declarations, and which makes a best effort to pre-compute the result of
  eager references.</dd>
</dl>

Our input will be *JavaScript* with two possible extra annotations.
After `const` or `function` and before an identifier, a programmer may specify
that the declaration is *moot* or *eager* thus:

```js
// references to f will be aggressively run early.
const /* @prebake.moot */ f = ...;

// Allowed for exported values.
// Importers will recognized that g is eager.
export const /* @prebake.eager */ g = ...;

// NO!  Not allowed for let or var.
let x = ...;

// Allowed for function declarations that are not reassigned.
function /* @prebake.moot */ h() {
  ...
}

// Allowed in complex destructuring assignments.
const {
  neitherMootNorEager,
  /* @prebake.eager */ foo,
  bar: /* @prebake.moot */ boo,
} = ...;

// Annotations on loop variables will never come into scope.
for (const /* @prebake.moot */ element of sequence) { ... }
// If you want to generate code based on a moot function* then
// use a top level
```

## Changes to JavaScript API

### `eval(AST)` will inline code.

Per JS semantics ([18.2.1.1](https://tc39.github.io/ecma262/#sec-performeval) step 2)
`eval(x)` is *x* when `typeof x !== 'string'`.  When running
under the prebakery, if *x* is a string or AST, then the prebakery will wrap *x*
in a function that takes its free variables as arguments, and put it in a
lookup table, so that previously seen versions of *x* are executable at
compile time.  Passing an *x* that is neither a string, nor an AST is a fatal
error.  For compatibility we may allow *null*/*undefined* through.

## New global function `Module()`.

`Function(...)` allows parsing a string as a *FunctionBody* but there is no
programmatic way to parse a string as a *ModuleBody*.

We will extend the builtins with a global *Module* function that returns a
module identifier that may be used with the `import(...)` operator.

When running under the prebakery, the argument will be added to the set of
modules to output.

The polyfill below can implement `Module` when not running under the prebakery:

```js
function Module(body) {
  // ASTs not supported in polyfill mode
  if (typeof body !== 'string') { throw new TypeError(); }
  // +module not supported per https://mathiasbynens.be/demo/javascript-mime-type
  // but not needed since this URL only needs to work with import(...).
  // TODO: test body containing '#'.
  return `data:text/javascript,${ encodeURIComponent(body) }`;
}
```

TODO: Hang `Module` and other extension points off `global.prebake`?

## `addEventListener('programWhole', function () { ... })`

A program's main module should be able to hook into the prebakery once
the set of modules available.

This will allow user code to assume many build-system duties like
running code quality scanners and linters.

There are two common idioms for reacting to events that are scoped to
the whole program.

*  In the browser, [`window.addEventListener`](https://developer.mozilla.org/en-US/docs/Web/Guide/Events/Creating_and_triggering_events#Creating_custom_events).
*  In Node.js, [`process.on`](https://nodejs.org/api/process.html#process_process_events)

There is no reason to prefer one to the other, so the idioms

`global.prebake.addEventListener('programWhole', f)`,
`global.prebake.on('programWhole', f)` should register f to run once
all modules and the module import graph are available as analyzable
artifacts.


## Algorithms and internal data types

### Value pool type

The goal of the value pool algorithm is to let prebaked output code reconstruct
the portion of the object graph created by early-running code.

A value pool's state of
*   A WeakMap that maps pooled values to [proxy, valueHistory]
    *   proxy keeps valueHistory up-to-date by trapping sets/deletes
        and property redefinitions.
        It may also trap construct for functions to create new
        entries with *CreateViaConstruct* entries.
*   A sequence counter so that we can reorder history entries
    once we've figure out which objects the prebaked output will need.

A value history is a set of mutations that will recreate an object.
A value history is represented as
1.  An origin event.  One of
    *   CreateViaCall (callee, this value, arguments)
    *   CreateViaConstruct (callee, arguments)
    *   GetFromGlobal (property name or symbol)
1.  An ordered array of changes in
    *   SetPrototypeOf (value)
    *   DefineProperty (property name or symbol, descriptor)
    *   Set (property name or symbol, value)
    *   Delete (property name or symbol)
    *   SetNonExtensible
Each history entry has a sequence number so that the compact algorithm
can order history entries for object that outlive prebaking.

We will assume, for efficiency, that no *\[\[Get\]\]* on a non getter
property mutates state.  There may be corner cases around Proxy objects
that violate this, but those should be corrigible by intercepting calls
to `new Proxy` if needed.

#### Value pool methods

*ValuePool*.pool(*x*):
1.  If *x* is a primitive and not a symbol, return it.
1.  If the WeakMap has *x*,
    1.  Return the proxy portion of the value corresponding to *x* in the WeakMap.
1.  If *x* is a symbol
    1.  Determine whether `Symbol.for` created it or not.
    1.  Record how to recreate it in the pool.
    1.  Return *x*.
1.  Otherwise *x* is an object, array, or function.
    1.  Let *p* be a proxy over *x* that traps mutations to *x* and
        adds history to the pool.
    1.  Put the entry [ *x*, *p* ] in the WeakMap.
    1.  Return *p*.

*ValuePool*.new(*x*):
1.  If `x` is an object, array, or function and is not a key in the WeakMap:
    Create history records based on the prototype of `x` and its own symbols and
    property names.
1.  Return the result of calling *ValuePool*.pool(*x*).

TODO: Can we combine .pool and .new?  Any objects created by calling host
functions like `document.createElement` should be handled by monkey-patching
those to create a `CreateViaCall` entry.  That might also be the easiest way
to handle *Symbol* creation and potential multiple-realm issues.

TODO: Do we need a *ValuePool*.closure that lets us effectively pool
closures that share stack frames perhaps by rewriting `let shared;
function f() { return shared }` to something like `let closedOver = {
shared: undefined }; function f() { return closedOver.shared; }` so
that we can pool closedOver when a function value is created by
evaluating a function expression?

*ValuePool*.compact(*startingPoints*) behaves similar to mark and sweep:
1.  Resolves startingPoints to pool entries in the *WeakMap* and marks those
    as needed.  TODO: This probably requires maintaining a reverse *WeakMap* mapping
    proxies to the objects they wrap.
1.  While the needed set is increasing:
    1.  Walk needed values' histories and marks as needed any objects
        that appear as values or arguments in history entries.
1.  Merge sort the histories for all needed values by sequence number to come up
    with a recipe that will recreate the object graph.
1.  Return the recipe.

### Prebake algorithm

TODO: This is almost certainly wrong.  Rewrite it entirely.

Given a set of starting modules that may use `/* @prebake... */` annotations:

1.  Look at `import`s and `require`s to expand the module set until it comprimses
    the whole program.
1.  For each module, compute the set of eager and moot declarations.
    *   A declaration is *moot* if
        *   it is eligible, it is a `const` declaration with an initializer
            or it is a `function` declaration and there exist no assignments
            to it
            (This assumes code is a *ModuleBody* or *FunctionBody* (CJS) since
             in *ScriptBody* productions top-level declarations alias global
             object properties)
            and
            *   it is marked with an explicit `/* @prebake.moot */` annotation
            *   it is bound to an export binding that is moot
    *   A declaration is *eager* if it is **not moot** per the rules above and
        *   it is eligible as defined above and
            *   it is marked with an explicit `/* @prebake.eager */` annotation or
            *   it is bound to an export binding that is eager or
1.  For each module, compute the set of AST nodes eligible for prebaking.
    *   An AST node is eligible for prebaking if
        *   it is a declaration whose destructuring declares at least one moot or eager
            symbol or
        *   it is a reference to a moot or eager symbol or
        *   it is a call to the `eval` operator or
        *   it is one of the patterns `window.eval` or `global.eval`
            where the corresponding object (`window` or `global`) is a global reference or
        *   any child is eligible for prebaking.
1.  Create a temporary directory.
1.  For each module, derive an instrumented AST and generate a source file
    in the temporary directory.
    1.  Copy the AST and instrument it.
        1.  Rewrite all `import`s and `require`s to point to instrumented files.
        1.  Replace all ineligible declarations' initializers with initializers
            with a reference to a special *NotReadyYet* sentinel value.
        1.  Replace all ineligible statements with no-ops.
        1.  Replace all ineligible expressions with *NotReadyYet*.
        1.  For each eligible call expression,
            1.  If it is a call to `eval`, `window.eval`, `global.eval`
                1.  generate a *call-site-identifier* so we can
                    later inline the evaluated code back into the AST.
                1.  If it really is a call to eval (see variants below)
                    1.  associate the code with the call-site-id
                    1.  otherwise performs as for a normal function call below.

                Caveat: There are multiple different variants of eval:
                *   Global `(0, eval)(code)`
                *   Local `eval(code)`
                *   Possible `let eval = Math.random() < 0.5 ? global.eval : () => {}; eval(code)`
                So we need to record based on syntax whether it is global or local, but
                delay until runtime whether the call was an `eval` per
                step [4.a](http://www.ecma-international.org/ecma-262/6.0/#sec-function-calls-runtime-semantics-evaluation).

                We assume that any argument to `eval` is not itself early running
                code, so do not support nested `eval`.

            1.  Otherwise rewrite the call so that we can
                *  The callee is not *NotReadyYet*
                *  Check that *thisValue* is not *NotReadyYet* and arguments are not
                   *NotReadyYet*
                *  The result is passed through the value pool's `pool` method.
        1.  For each eligible construct expression `new ...`, object literal `{ ... }`,
            and array literal `[ ... ]` expression:
            *   Rewrite so thate the result
        1.  For each other eligible expression:
            *   If it could yield a symbol, object, or function pass it through
                the value pool.
                For debugging purposes, this branch should fail early if the value
                was not in the pool.  We should seed the pool with intrinsics so that
                all new objects that we need to track come from branches instrumented
                with value creation in mind.
        1.  For each compilation unit, at the start register a function
            that dumps a map that relates each eligible declaration's value
            to an entry in the pool.
    1.  Write the AST to the temp file for the module.
1.  Prebake the user code.
    1.  Start a JS engine and initialize the runtime environment for early running code.
        *   Initialize a value pool.  See the value pool algorithm.
        *   Replace `Function` and `Function.prototype.constructor` with a
            `new Proxy(Function)` that traps *\[\[Call\]\]* and *\[\[Construct\]\]*
            messages to `Function` and adds history to the value pool to create a
            `function (...)` from the arguments.
        *   Replace `Proxy` with a proxy (so meta-) so that the pool can reconstruct
            proxies.
        *   Set up a `console` so we can collect log trace during prebaking.
    1.  Load the start modules into the JS engine.
    1.  Call the registered function for each compilation unit so we can relate
        pool entries to values for *eager* declarations.
    1.  Compact the value pool using the set of values that are needed per registered
        functions.
    1.  Serialize the object pool, and any code destined for call-site identifiers.
1.  For each module
    *   Add an import to the serialized value pool at the top, so that early objects
        come to be before non-eager code runs.
    *   Remove all *moot* declarations' initializers that are not imports.
    *   Replace *eagar* declaratios' initializers with a reference into the value pool.
    *   For each call-site-identifier, introduce a map from (hash of code, is direct)
        to `() => /* evaled code goes here */` like
        ```js
        const earlyEvaluated = new Map([
          'Str0N6.h45H': () => ...,
        ]);
        ```
        and then the call to `eval(...args)` becomes an expression that
        1.  If `eval` is not `global.eval` (perhaps referenced via pool):
            1.  Just execute `eval(...args)`
        1.  Let *hash* = hash of (String(args[0]), isDirect)
        1.  If *earlyEvaluated* has *hash* then
            1.  Let *precompiled* = earlyEvaluated.get(*hash*)
            1.   Call *precompiled*().  Since it's a lambda, there's no need
                 to supply a ThisValue.
        1.  Otherwise raise an error
1.  Emit the rewitten ASTs, serialized value pool, and source maps.



[core-js-example]: https://github.com/zloirock/core-js/blob/2a005abe68520248d4431cab70d86e40b55d6e98/packages/core-js/internals/global.js#L5
[domain specific language]: https://en.wikipedia.org/wiki/Domain-specific_language
