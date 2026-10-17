"""Privacy boundary for categorization (R3.4).

Everything that may reach an LLM about a transaction is produced here: a normalized,
scrubbed merchant key, a coarse amount bucket, a direction, and an account kind.
Invariant: a key never contains a run of more than 3 digits nor any owner name token.
"""

import re
from collections.abc import Iterable
from decimal import Decimal

from app.models.base import AccountType
from app.providers.llm.base import AccountKind, AmountBucket, MerchantInput

MAX_KEY_LENGTH = 200
EMPTY_KEY = "UNKNOWN"

# Processor prefixes that hide the real merchant behind a gateway ("SQ *", "TST*", "PP*").
_PROCESSOR_PREFIX = re.compile(r"^(?:SQC|SQ|TST|PP|PAYPAL|SP|CKO)\s*\*\s*")

# Counterparty names must never leave the machine: keep the rail, drop whoever follows.
_ZELLE = re.compile(r"\bZELLE\b(?:\s+(?:PAYMENT|TRANSFER))?\s+(TO|FROM)\b.*$")
_VENMO = re.compile(r"\bVENMO\b(?:\s+(PAYMENT|CASHOUT|CASH OUT|TRANSFER|ADD MONEY))?\b.*$")

# Other person-to-person rails: keep the rail (and TO/FROM or SENT/RECEIVED), drop the rest.
# Known limitation: "PAYPAL *<name>" is not handled. PayPal merchant names are useful for
# classification and a person cannot be told apart from a merchant, so the name is kept.
_WIRE = re.compile(
    r"\b(?:(?:INCOMING|OUTGOING)\s+)?WIRE\b(?:\s+(?:TRANSFER|PAYMENT))?(?:\s+(TO|FROM)\b)?.*$"
)
_CASH_APP = re.compile(r"\bCASH\s*APP\b(?:\s+TRANSFER)?(?:\s+(TO|FROM)\b)?.*$")
_APPLE_CASH = re.compile(r"\bAPPLE\s+CASH\b(?:\s+(SENT|RECEIVED)\b)?.*$")
_PAYPAL_INSTANT = re.compile(r"\bPAYPAL\s+(INST\s+XFER|INSTANT\s+TRANSFER)\b.*$")
_BANK_TRANSFER = re.compile(r"\b((?:ONLINE\s+|MOBILE\s+)?(?:TRANSFER|XFER))\s+(TO|FROM)\b.*$")

# Markers after which everything is reference data (ACH ids, confirmation numbers, memos).
_TRAILING_REFERENCE = re.compile(
    r"\b(?:PPD|WEB|CCD|CTX|TEL)\s+ID\b.*$"
    r"|\bCONF(?:IRMATION)?\s*(?:#|NO\b|NUM\b).*$"
    r"|\bREF(?:ERENCE)?\s*(?:#|NO\b|NUM\b).*$"
    r"|\bTRACE\s*(?:#|NO\b).*$"
)

_STAR_REFERENCE = re.compile(r"\*\s*[A-Z0-9]*\d[A-Z0-9]*")  # "*2K4LM9TQ1"
_NUMBER_SIGN = re.compile(r"#\s*[A-Z0-9-]+")  # store numbers, "CHECK # 1042"
_MASKED_ACCOUNT = re.compile(r"(?:\.{2,}|\bX{2,}|\*{2,})\s*\d*")
_ENDING_IN = re.compile(r"\bENDING\s+IN\b\s*\d*")

_PHONE = re.compile(r"(?<!\d)(?:\+?1[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)")
_SHORT_PHONE = re.compile(r"(?<!\d)\d{3}-\d{4}(?!\d)")
_DATE = re.compile(
    r"(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)"
    r"|(?<!\d)\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?(?!\d)"
)
_DIGIT_GROUPS = re.compile(r"(?<!\d)\d+(?:[\s-]+\d+)+(?!\d)")
_LONG_DIGITS = re.compile(r"\d{4,}")
_EDGE_PUNCTUATION = re.compile(r"^[\s\-*#.,/:;|]+|[\s\-*#.,/:;|]+$")


def _drop_digit_groups(text: str) -> str:
    """Remove card-number-like digit groups split by spaces or dashes once they hold 4+ digits."""
    return _DIGIT_GROUPS.sub(
        lambda m: " " if sum(c.isdigit() for c in m.group()) >= 4 else m.group(), text
    )


def _strip_owner_tokens(text: str, owner_name_tokens: Iterable[str]) -> str:
    """Remove owner name tokens as words, then any word that still embeds one."""
    tokens = sorted(
        {t.strip().upper() for t in owner_name_tokens if len(t.strip()) >= 2}, key=len, reverse=True
    )
    if not tokens:
        return text
    alternatives = "|".join(re.escape(t) for t in tokens)
    text = re.sub(rf"\b(?:{alternatives})\b", " ", text)
    words = [w for w in text.split() if not any(t in w for t in tokens)]
    return " ".join(words)


def merchant_key(raw_description: str, owner_name_tokens: Iterable[str] = ()) -> str:
    """Normalize a raw bank description into a scrubbed, cacheable merchant key."""
    text = " ".join(raw_description.upper().split())

    text = _PROCESSOR_PREFIX.sub("", text)
    text = _WIRE.sub(lambda m: "WIRE" + (f" {m.group(1)}" if m.group(1) else ""), text)
    text = _CASH_APP.sub(lambda m: "CASH APP" + (f" {m.group(1)}" if m.group(1) else ""), text)
    text = _APPLE_CASH.sub(lambda m: "APPLE CASH" + (f" {m.group(1)}" if m.group(1) else ""), text)
    text = _PAYPAL_INSTANT.sub(r"PAYPAL \1", text)
    text = _BANK_TRANSFER.sub(r"\1 \2", text)
    text = _ZELLE.sub(r"ZELLE \1", text)
    text = _VENMO.sub(lambda m: "VENMO" + (f" {m.group(1)}" if m.group(1) else ""), text)
    text = _TRAILING_REFERENCE.sub(" ", text)
    text = _PROCESSOR_PREFIX.sub("", text)
    text = _STAR_REFERENCE.sub(" ", text)
    text = _NUMBER_SIGN.sub(" ", text)
    text = _MASKED_ACCOUNT.sub(" ", text)
    text = _ENDING_IN.sub(" ENDING IN ", text)
    text = _PHONE.sub(" ", text)
    text = _DATE.sub(" ", text)
    text = _SHORT_PHONE.sub(" ", text)
    text = _drop_digit_groups(text)
    text = _LONG_DIGITS.sub(" ", text)
    text = text.replace("*", " ")
    text = _strip_owner_tokens(text, owner_name_tokens)

    text = " ".join(text.split())
    text = _EDGE_PUNCTUATION.sub("", text)
    if len(text) > MAX_KEY_LENGTH:
        text = text[:MAX_KEY_LENGTH].rsplit(" ", 1)[0]
    return text or EMPTY_KEY


def amount_bucket(amount: Decimal) -> AmountBucket:
    """Coarse magnitude of a transaction, sign ignored."""
    size = abs(amount)
    if size < 10:
        return "<10"
    if size < 50:
        return "10-50"
    if size < 200:
        return "50-200"
    if size <= 1000:
        return "200-1000"
    return ">1000"


def account_kind(account_type: AccountType) -> AccountKind:
    return account_type.value  # AccountType values are exactly the AccountKind literals


def build_merchant_input(key: str, amount: Decimal, account_type: AccountType) -> MerchantInput:
    """The only shape in which a transaction is described to an LLM."""
    return MerchantInput(
        merchant_key=key,
        amount_bucket=amount_bucket(amount),
        direction="inflow" if amount > 0 else "outflow",
        account_kind=account_kind(account_type),
    )
