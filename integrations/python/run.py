"""Bounded CLI for installed research packages; deliberately no live command."""
import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

from adapters import PublicCoinbase, compare_candles, run_backtests, validate_bundle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['backtest', 'sdk-check'])
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    payload = args.input.read_bytes()
    bundle = json.loads(payload)
    validate_bundle(bundle)
    if args.command == 'backtest':
        result = dict(scenarios=[run_backtests(bundle, spread_bps=10, adverse_bps=10),
                                 run_backtests(bundle, spread_bps=30, adverse_bps=20)], passed=None)
    else:
        # Three deterministic windows, bounded to nine requests for default markets.
        end = bundle['end']
        width = min(60, (end - bundle['start']) // 60) * 60
        starts = sorted(set([bundle['start'], ((bundle['start'] + end - width) // 120) * 60, end - width]))
        client = PublicCoinbase()
        checks = []
        try:
            for market in bundle['markets']:
                for start in starts:
                    response = client.get_public_candles(market['product'], str(start), str(start + width),
                                                         'ONE_MINUTE', limit=350).to_dict()
                    check = compare_candles(market['rows'], response['candles'], start, start + width)
                    checks.append(dict(product=market['product'], start=start, end=start + width, **check))
                    time.sleep(.2)
        finally:
            client.session.close()
        result = dict(engine='coinbase-advanced-py', engineVersion=version('coinbase-advanced-py'),
                      inputSha256=bundle['inputSha256'], passed=all(c['passed'] for c in checks), checks=checks,
                      limitations=['Same exchange, independent client and public REST route.',
                                   'Samples three windows per market; does not verify the entire dataset.'])
    result.update(createdAt=datetime.now(timezone.utc).isoformat(),
                  bundleSha256=hashlib.sha256(payload).hexdigest(),
                  adapterSha256=hashlib.sha256(Path(__file__).with_name('adapters.py').read_bytes()).hexdigest(),
                  runnerSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  lockSha256=hashlib.sha256(Path(__file__).with_name('requirements.lock').read_bytes()).hexdigest())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.output.with_suffix('.tmp')
    tmp.write_text(json.dumps(result, indent=2, allow_nan=False), encoding='utf-8')
    tmp.replace(args.output)
    print(json.dumps(dict(command=args.command, output=str(args.output), passed=result['passed'])))
    return 2 if result['passed'] is False else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        # Avoid dumping provider response bodies or ambient environment details.
        print(f'External research failed: {type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
