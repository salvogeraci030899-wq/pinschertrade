"""Test del formato italiano dei messaggi. `python3 tests/test_fmt_it.py` oppure pytest."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from fmt_it import it, it_g  # noqa: E402


def test_formato_italiano():
    assert it(3.015) == "3,02"                      # non «3.015»: si leggerebbe tremila
    assert it(1523.4) == "1.523,40"
    assert it(1.0, 2, True) == "+1,00"
    assert it(-0.5, 2, True) == "-0,50"
    assert it_g(1.0) == "1" and it_g(0.25) == "0,25" and it_g(2.5) == "2,5"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} test superati")
