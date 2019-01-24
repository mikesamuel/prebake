# Eval, The Good Parts.

> ## `eval` is Evil
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

## Why do responsible programmers `eval`?

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

It's not the only way to do meta-programming tricks like

*  the [core-js][core-js-example] one (15M downloads/week)
*  creating wrapper functions with the right `.length`

but safe to do so.

## Checking uses of `eval`

Some proposals like
[Trusted Types](https://wicg.github.io/trusted-types/dist/spec/#string-compilation)
aim to make it easier to confidently use `eval` safely by requiring
developers to be explicit about which strings are safe to load as code in
a way that blue-teamers can double check.

It's going to take some time for library code to change to take that into account
though.

## What distinguishes "good" `eval`?

The legitimate use cases I've seen all have the property that they could happen
before the system starts processing untrusted inputs.

[Ad-hoc reporting](https://www.techopedia.com/definition/30294/ad-hoc-reporting)
is important but not, IMO, a good use of `eval`.  It involves executing equations
reached over the network, and careful library code can do that efficiently.

## Proposal

A *Prebakery* takes a set of JS modules, runs `eval` and `new Function` early,
and either

*  either emits an equivalent JavaScript program that does not depend
   on `eval` and `new Function`
*  or reports which uses it could not precompute.

## Design and interface

We want to preserve semantics where possible.

Our end goal is to have `eval` and `Function` no longer needed.
Functions that definitely use these should be moot by the time
the system opens up to untrusted inputs.

Preserving semantics perfectly does not seem possible, so we will bite the
bullet and allow that order of execution may change in predictable ways.

**Caveat**: Semantics may differ in that the initializers for clearly
marked declarations and expressions that depend on clearly marked
declarations may execute before those that are/do not.

----

Some functions may use *moot* functions if they're available but
not in all possible code-paths.

<dl>
  <dt>moot</dt>
  <dd>a declaration is moot if the program should not need it to function
  by the time untrusted input could reach it.</dd>
  <dt>eager</dt>
  <dd>a function is eager if it should run early where possible, but may not in
  all cases.</dd>
  <dt>early</dt>
  <dd>either eager or early</dd>
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



## Algorithms

### Prebake algorithm

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
A value history is represented as an array whose elements are one of:
*   CreateViaCall (callee, this value, arguments)
*   CreateViaConstruct (callee, arguments)
*   SetPrototypeOf (value)
*   DefineProperty (property name or symbol, descriptor)
*   Set (property name or symbol, value)
*   Delete (property name or symbol)
Each history entry has a sequence number so that the compact algorithm
can order history entries for object that outlive prebaking.

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


[core-js-example]: https://github.com/zloirock/core-js/blob/2a005abe68520248d4431cab70d86e40b55d6e98/packages/core-js/internals/global.js#L5
[domain specific language]: https://en.wikipedia.org/wiki/Domain-specific_language
