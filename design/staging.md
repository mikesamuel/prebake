# Staging

Explains how the parts of the [prebakery](#prebakery) work together.

[![modular decomposition](draft-modular-decomposition.png)](draft-modular-decomposition.png)

## Glossary

*   <a name="prebakery"> *Prebakery </a> : Given [IDs][module id] of JavaScript sources,
    produces equivalent JS that does not use [moot][] declarations and that uses as
    few [eager][] declarations as possible.
    A prebakery takes some [initial module id][]s and does the following:
    1.  Uses a [gatherer][] to collect JS [module source][]s.
    1.  Uses a [rewriter][] to figure out how to run some of that code [early][].
        (This may involve circling back to the [gatherer][] if early code dynamically loads ungathered modules.)
    1.  Uses a [reknitter][] to replace the [early][] parts with equivalent code.
    1.  Produces an output [module set][] with [module metadata][].
*   <a name="gatherer"> *Gatherer* </a> : Part of the [prebakery][] responsible for maintaining a [module set][],
    and its [load order][].  The gatherer interacts with the [fetcher][] to get [module source][]s for [module id][]s.
*   <a name="fetcher"> *Fetcher* </a> : [second party code][] that abstracts away the file system
    and is the main interoperability point for [third party system][]s like build systems and IDEs.
    A fetcher may be asked to
    *   canonicalize([module id][], [base][]) returns one that can be compared to tell if two [module id]s refer
        to the same module.
    *   list([module glob][], [base][]) returns a list of [module id][]s.  For example given `foo/*.js` may return
        the list of JavaScript files.
    *   fetch([module id][], [base][]) returns [module source][] and [module metadata][] including
    Any fetcher operation may return the special value DOES_NOT_UNDERSTAND to indicate that the fetcher does
    not understand the [module id][] or [module glob][].  This is meant to allow chaining of fetchers.
*   <a name="cassandra"> *Cassandra* </a> : Cassandra is [second party code][] responsible for routing
    error messages to [third party system][]s which may ignore them at their own peril.
*   <a name="rewriter"> *Rewriter* </a> : The rewriter takes the [module source][] of each module
    and instruments it so that it
    *   contains only declarations and code blocks needed to evaluate [early][] code.
    *   proxies operations through the [historian][] so that the needed portions of the object graph
        can be reconstructed.
    *   exports a dump of top level variables so that the [reknitter][] can properly initialize them.
*   <a name="oven"> *Oven* </a> : Loads the [historian][], [runtime stubs][], and [module set][] into
    a [dedicated js realm][] to evaluate [early][] code.
*   <a name="historian"> *Historian* </a> : During evaluation of [early][] code, keeps track of how
    objects came to be so that the [reknitter][] can produce code that recreates the necessary parts
    of the object graph.
*   <a name="runtime-stubs"> *Runtime stubs* </a> : JavaScript code that runs alongside early code.
    This includes implementations of code loading machinery like
    *   implementations of `require` and `import()` that route back through the [fetcher][] so that any
        dynamically required modules end up as part of the [module set][].
    *   an implementation of the proposed `new Module(...)` API that adds dynamically created modules
        to the current [module set][].
    *   library code that makes inputs to [direct eval][] and [indirect eval][] available to the
        [reknitter][] along with the [callsite][] context.
    *   Note: `new Function()` does not require stubbing since the [historian][] should get enough to
        recreate dynamically created functions via other channels.
*   <a name="reknitter"> *Reknitter* </a> : The reknitter is responsible for re-incorporating the
    results of [early] code evaluation back into modules.
    To do this it needs:
    *   [swiss module][]s from the [rewriter][] which show where early code was removed and relate
        holes.  The [rewriter][] can produce these as it instruments and having an AST with holes
        clearly marked avoids overly-tight-coupling between [rewriter][] and [reknitter][].
    *   [object histories][] from the [historian][] that can be turned into generated code that
        rebuilds object values 
    *   a [variable digest][] for each module from the [dedicated js realm][] that relates
        the result of a top-level `const x = foo();` to the AST node for the `const x` declaration
        in the [swiss module][].
    The reknitter emits a [module set][] which the [prebakery][] may repackage based on configuration
    options as either one or multiple JS files.

*   <a name="module-metadata"> *Module metadata* : Metadata about a [module][] including
    *   any [source map][]
    *   any additional [import map][]s assumed by imports.
    *   any content mime-type possibly including a specification year, e.g. ECMA-262 2019
    The [fetcher][] may supply additional metadata fields which will make it through to the output unchanged.

*  <a name="second-party-code"> *Second party code* </a> : JavaScript or TypeScript code that plugs
   into the prebakery to customize behavior.  This is "second party" because it may be supplied by
   tools developers or users.
*  <a name="third-party-systems"> *Third party systems* </a> : Systems that interoperate with the prebakery
   but which are not necessarily written in JS or which cannot run in the same address space.
   For example, IDEs, build systems like Bazel and Gulp, Github, etc.

[gatherer]: #gatherer
[prebakery]: #prebakery
[fetcher]: #fetcher
[rewriter]: #rewriter
[oven]: #oven
[historian]: #historian
[runtime stubs]: #runtime-stubs
[second party code]: #second-party-code
[third party system]: #third-party-system
[module metadata]: #module-metadata
[cassandra]: #cassandra

[dedicated js realm]: #dedicated-js-realm
[reknitter]: #reknitter
[eager]: #eager
[moot]: #moot
[early]: #early
[module]: #module
[module id]: #module-id
[module glob]: #module-glob
[module set]: #module-set
[module source]: #module-source
[load order]: #load-order
[base]: #base
[source map]: #source-map
[import map]: #import-map
[direct eval]: #direct-eval
[indirect eval]: #indirect-eval
[callsite]: #callsite
[swiss module]: #swiss-module
[object histories]: #object-history
[object history]: #object-history
[variable digest]: #variable-digest
[initial module id]: #initial-module-id
