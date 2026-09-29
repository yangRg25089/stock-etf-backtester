"""Run provider that exposes the repository-owned Task 4 fixture to E2E runs."""

from __future__ import annotations

from collections.abc import Sequence
from concurrent.futures import Executor, Future
from decimal import Decimal
from typing import Any

from app.calendar import ExchangeCalendar
from app.config.validation import DataRequirement
from app.data.fixtures import FixtureBundle, load_fixture
from app.data.market_data import align_macro_observations
from app.domain.contracts import (
    DataSnapshot,
    FrozenStrategyInstance,
    SharedSettings,
)
from app.runs.data import StrategyDataLoad
from app.runs.manager import RunManager
from app.runs.store import InMemoryRunStore


class Task4FixtureProvider:
    """Return normalized fixture data, including point-in-time macro alignment."""

    def __init__(self, bundle: FixtureBundle | None = None) -> None:
        self.bundle = load_fixture("task4_core") if bundle is None else bundle
        last_session = self.bundle.exchange_dates[-1]
        self.calendar = ExchangeCalendar.from_dates(
            self.bundle.exchange_dates,
            as_of_date=last_session,
            latest_complete_date=last_session,
            calendar_coverage_end_date=last_session,
        )
        self.version = f"fixture:{self.bundle.fixture_id}:{self.bundle.version}"

    def load_for_strategy(
        self,
        *,
        shared: SharedSettings,
        strategy: FrozenStrategyInstance,
        requirements: Sequence[DataRequirement],
    ) -> StrategyDataLoad:
        del strategy, requirements
        target_sessions = tuple(
            session
            for session in self.calendar.trading_dates
            if shared.run.start_date <= session <= shared.run.end_date
        )
        aligned = align_macro_observations(
            self.bundle.snapshot.macro,
            exchange_calendar=self.calendar,
            target_sessions=target_sessions,
            max_staleness_sessions=shared.data.macro_staleness_sessions,
        )
        market = self.bundle.snapshot.market
        chart_market = market.model_copy(
            update={
                "bars": tuple(
                    bar.model_copy(
                        update={
                            "simulation_open": bar.simulation_price * Decimal("0.995"),
                            "simulation_high": bar.simulation_price * Decimal("1.02"),
                            "simulation_low": bar.simulation_price * Decimal("0.98"),
                        }
                    )
                    for bar in market.bars
                ),
                "fingerprint": f"{market.fingerprint}:ohlc-chart-fixture",
            }
        )
        snapshot: DataSnapshot = self.bundle.snapshot.model_copy(
            update={
                "market": chart_market,
                "macro": aligned.observations,
                "fingerprint": f"{self.bundle.snapshot.fingerprint}:ohlc-chart-fixture",
            }
        )
        return StrategyDataLoad(calendar=self.calendar, snapshot=snapshot)


class ImmediateExecutor(Executor):
    """Run manager work synchronously so API integration tests stay deterministic."""

    def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Future[Any]:
        future: Future[Any] = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as error:
            future.set_exception(error)
        return future


def create_fixture_run_manager(*, immediate: bool = True) -> RunManager:
    return RunManager(
        store=InMemoryRunStore(),
        data_provider=Task4FixtureProvider(),
        executor=ImmediateExecutor() if immediate else None,
    )
