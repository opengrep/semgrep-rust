/*
 * semgrep-rust
 *
 * Extend the original tree-sitter Rust grammar with semgrep-specific constructs
 * used to represent semgrep patterns.
 */

const standard_grammar = require('tree-sitter-rust/grammar');

module.exports = grammar(standard_grammar, {
  name: 'rust',

  // 'const unsafe' starts a function, a const impl or a const trait, and
  // 'const' in a bound starts a const bound or a function pointer type; the
  // token after it decides.
  conflicts: ($, previous) => previous.concat([
    [$.function_modifiers, $.impl_item, $.trait_item],
    [$.function_modifiers, $.trait_item],
    [$.function_modifiers, $.const_bound],
  ]),

  rules: {

    // Entry point
    source_file: ($, previous) => {
      return choice(
        previous,
        $.semgrep_expression,
        $.semgrep_statement,
      );
    },

    // A line comment is one token, doc comments included, as before
    // tree-sitter-rust 0.21: comments are extras and opengrep does not use
    // the structure of doc comments, which costs a CST node per marker and
    // per content.
    line_comment: _ => token(seq('//', /.*/)),

    // Alternate "entry point". Allows parsing a standalone expression.
    semgrep_expression: $ => seq('__SEMGREP_EXPRESSION', $._expression),

    // Alternate "entry point". Allows parsing a standalone list of statements.
    semgrep_statement: $ => seq('__SEMGREP_STATEMENT', repeat1($._statement)),

    semgrep_typed_metavar: $ =>
      seq(
        $.identifier,
        ':',
        $._type,
      ),

    // Metavariables
    identifier: ($, previous) => {
      return token(
        choice(
          previous,
          /\$[A-Z_][A-Z_0-9]*/,
          /\$\.\.\.[A-Z_][A-Z_0-9]*/,
        )
      );
    },

    // Statement ellipsis: '...' not followed by ';'
    expression_statement: ($, previous) => {
      return choice(
        previous,
        prec.right(100, seq($.ellipsis, ';')),  // expression ellipsis
        prec.right(100, $.ellipsis),  // statement ellipsis
      );
    },

    _declaration_statement: ($, previous) => {
      return choice(
        previous,
        $.decl_macro,
        $.trait_alias,
        $.ellipsis
      );
    },

    // Trait alias (unstable trait_alias):
    // https://doc.rust-lang.org/unstable-book/language-features/trait-alias.html
    trait_alias: $ => seq(
      optional($.visibility_modifier),
      'trait',
      field('name', $._type_identifier),
      field('type_parameters', optional($.type_parameters)),
      '=',
      field('bounds', sepBy1('+', choice(
        $._type,
        $.lifetime,
        $.higher_ranked_trait_bound,
      ))),
      optional($.where_clause),
      ';',
    ),

    // Declarative macro 2.0 (unstable decl_macro):
    // https://doc.rust-lang.org/unstable-book/language-features/decl-macro.html
    decl_macro: $ => seq(
      optional($.visibility_modifier),
      'macro',
      field('name', choice($.identifier, $._reserved_identifier)),
      field('parameters', optional(
        alias($._decl_macro_parameters, $.token_tree))),
      field('body', alias($._decl_macro_body, $.token_tree)),
    ),

    _decl_macro_parameters: $ => seq('(', repeat($._delim_tokens), ')'),

    _decl_macro_body: $ => seq('{', repeat($._delim_tokens), '}'),

    // 'const' traits (unstable const_trait_impl), impl restrictions
    // (unstable impl_restriction, RFC 3323) and auto traits (unstable
    // auto_traits): pub impl(self) const unsafe auto trait T
    trait_item: ($, previous) => seq(
      optional(seq($.visibility_modifier, optional($.impl_restriction))),
      optional('const'),
      previous.members[1],
      optional('auto'),
      ...previous.members.slice(2),
    ),

    impl_restriction: $ => seq(
      'impl',
      '(',
      choice($.self, $.super, $.crate, seq('in', $._path)),
      ')',
    ),

    // 'const' impls (unstable const_trait_impl): const impl Trait for T
    impl_item: ($, previous) => seq(
      optional('const'),
      ...previous.members,
    ),

    // A const trait bound (unstable const_trait_impl): '[const] Trait', or
    // '~const Trait' in older code. Like the removed_trait_bound '?Trait' of
    // tree-sitter-rust, it is a type, so it can appear in trait bounds and
    // in impl and bounded types.
    _type: ($, previous) => choice(
      ...previous.members,
      $.const_trait_bound,
    ),

    const_trait_bound: $ => seq($.trait_bound_modifier, $._type),

    // impl [const] Trait
    abstract_type: ($, previous) => seq(
      previous.members[0],
      previous.members[1],
      field('trait', prec(previous.members[2].content.value, choice(
        ...previous.members[2].content.content.members,
        $.const_trait_bound,
      ))),
    ),

    trait_bound_modifier: $ => choice(
      seq('[', 'const', ']'),
      '~const',
    ),

    // 'const Trait' is a const trait bound in a list of trait bounds only:
    // elsewhere 'const' starts a const generic parameter.
    trait_bounds: $ => seq(
      ':',
      sepBy1('+', choice(
        $._type,
        $.lifetime,
        $.higher_ranked_trait_bound,
        $.const_bound,
      )),
    ),

    const_bound: $ => seq('const', $._type),

    // 'safe' items in an 'unsafe extern' block (Rust 1.82), and 'final'
    // methods of a trait (unstable final_associated_functions). 'safe' is a
    // contextual keyword, so it stays usable as an identifier.
    function_modifiers: ($, previous) => repeat1(choice(
      ...previous.content.members,
      'safe',
      'final',
    )),

    static_item: ($, previous) => seq(
      previous.members[0],
      optional('safe'),
      ...previous.members.slice(1),
    ),

    // Const closures (unstable const_closures): const |x| x + 1
    closure_expression: ($, previous) => prec(previous.value, seq(
      optional('const'),
      ...previous.content.members,
    )),

    // 'safe' and 'auto' are contextual keywords: they stay usable as
    // identifiers.
    _reserved_identifier: ($, previous) => alias(choice(
      ...previous.content.members,
      'safe',
      'auto',
    ), $.identifier),

    // A negative literal as a const generic argument: f::<-1>()
    type_arguments: $ => seq(
      token(prec(1, '<')),
      sepBy1(',', seq(
        choice(
          $._type,
          $.type_binding,
          $.lifetime,
          $._literal,
          $.block,
          $.negative_literal,
        ),
        optional($.trait_bounds),
      )),
      optional(','),
      '>',
    ),

    // The f16 and f128 suffixes (unstable f16, f128): 1f16, 0_f128
    integer_literal: ($, previous) => token(seq(
      previous.content.members[0],
      optional(choice(
        ...previous.content.members[1].members[0].members,
        'f16',
        'f128',
      )),
    )),

    // Metavariable expressions in a macro (unstable macro_metavar_expr):
    // ${concat($a, _b)}, ${index()}
    _tokens: ($, previous) => choice(
      ...previous.members,
      $.metavariable_expression,
    ),

    metavariable_expression: $ => seq('$', '{', repeat($._tokens), '}'),

    // super let (unstable super_let), and attributes on the value (unstable
    // stmt_expr_attributes): super let f = #[cold] || g();
    let_declaration: ($, previous) => seq(
      optional('super'),
      ...previous.members.slice(0, 4),
      optional(seq(
        '=',
        repeat($.attribute_item),
        field('value', $._expression),
      )),
      ...previous.members.slice(5),
    ),

    // A visibility on a type without a value, as in an extern type
    // (unstable extern_types): unsafe extern "C" { pub type Code; }
    associated_type: ($, previous) => seq(
      optional($.visibility_modifier),
      ...previous.members,
    ),

    field_declaration: ($, previous) => {
      return choice(
        previous,
        $.ellipsis
      );
    },

    // Expression ellipsis
    _expression: ($, previous) => {
      return choice(
        ...previous.members,
        $.ellipsis,
        $.deep_ellipsis,
        $.member_access_ellipsis_expression,
      );
    },

    parenthesized_expression: ($, previous) => seq(
      '(',
      choice($._expression, $.semgrep_typed_metavar),
      ')'
    ),

    // In a token tree, '...' is the semgrep ellipsis: the run of punctuation
    // tokens of tree-sitter-rust is rebuilt without it, so that a run such
    // as ', ...' ends before the ellipsis. '~' is a Rust punctuation token
    // that tree-sitter-rust leaves out of the run, and a macro can use it.
    // Each symbol of the run is one token of a single kind, so that the
    // generated CST matches it as one token rather than a choice of 45.
    _non_special_token: ($, previous) => choice(
      ...previous.members.map(member =>
        member.type === 'PREC_RIGHT'
          ? prec.right(repeat1(token(choice(
              ...member.content.content.members.filter(
                punctuation => punctuation.value !== '...'),
              '~'))))
          : member),
      $.ellipsis,
    ),

    // TODO: have to use 13 instead of PREC.field because the Rust grammar
    // doesn't export precedences. Should we use something like
    // https://github.com/jhnns/rewire to access this directly?
    member_access_ellipsis_expression: $ => prec(13, seq(
      field('expression', $._expression),
      '.',
      $.ellipsis
    )),

    deep_ellipsis: $ => seq(
      '<...', $._expression, '...>'
    ),

    ellipsis: $ => '...',
  }
});


function sepBy1(sep, rule) {
  return seq(rule, repeat(seq(sep, rule)))
}

function sepBy(sep, rule) {
  return optional(sepBy1(sep, rule))
}
