"""Characterize the first search relationship error before extracting modes."""

import pytest
from pydantic import ValidationError

from app.domain.contracts import SearchResult
from app.search import run_grid_search
from tests.search.test_optimization import split_source
from tests.search.test_walk_forward import run, source


@pytest.fixture(scope="module")
def searches():
    split = run_grid_search(split_source())
    walk, _ = run(source())
    full = split.model_copy(
        update={
            "optimization_mode": "full_period",
            "train_period": None,
            "test_period": None,
            "period_benchmarks": (),
            "candidates": tuple(
                row.model_copy(update={"test_result": None}) for row in split.candidates
            ),
        }
    )
    return {"full": full, "split": split, "walk": walk}


def broken_search(case, searches):
    full, split, walk = (searches[key] for key in ("full", "split", "walk"))
    cases = {
        "duplicate": (full, {"candidates": (full.candidates[0], full.candidates[0])}),
        "sequence": (full, {"candidates": tuple(reversed(full.candidates))}),
        "count": (full, {"total_candidate_count": 9}),
        "rank-duplicate": (
            full,
            {"ranked_candidate_ids": full.ranked_candidate_ids * 2},
        ),
        "rank-missing": (full, {"ranked_candidate_ids": ()}),
        "walk-required": (walk, {"walk_forward_windows": (), "out_of_sample": None}),
        "walk-partition": (
            walk,
            {"walk_forward_windows": tuple(reversed(walk.walk_forward_windows))},
        ),
        "walk-ranking": (
            walk,
            {"ranked_candidate_ids": tuple(reversed(walk.ranked_candidate_ids))},
        ),
        "walk-identity": (
            walk,
            {
                "out_of_sample": walk.out_of_sample.model_copy(
                    update={"result_id": walk.candidates[0].candidate_id}
                )
            },
        ),
        "walk-window-ranking": (
            walk,
            {
                "walk_forward_windows": (
                    walk.walk_forward_windows[0].model_copy(
                        update={
                            "ranked_candidate_ids": (
                                *walk.walk_forward_windows[0].ranked_candidate_ids,
                                walk.walk_forward_windows[1].ranked_candidate_ids[0],
                            )
                        }
                    ),
                    walk.walk_forward_windows[1].model_copy(
                        update={
                            "ranked_candidate_ids": walk.walk_forward_windows[
                                1
                            ].ranked_candidate_ids[1:]
                        }
                    ),
                )
            },
        ),
        "walk-contiguous": (
            walk,
            {
                "walk_forward_windows": (
                    walk.walk_forward_windows[0],
                    walk.walk_forward_windows[1].model_copy(
                        update={
                            "test_period": walk.walk_forward_windows[
                                1
                            ].test_period.model_copy(
                                update={
                                    "start_date": walk.walk_forward_windows[
                                        1
                                    ].test_period.start_date.replace(day=2)
                                }
                            )
                        }
                    ),
                )
            },
        ),
        "walk-period": (
            walk,
            {
                "out_of_sample_period": walk.out_of_sample_period.model_copy(
                    update={
                        "start_date": walk.out_of_sample_period.start_date.replace(
                            day=2
                        )
                    }
                )
            },
        ),
        "walk-baselines": (walk, {"period_benchmarks": ()}),
        "rolling-mode": (split, {"out_of_sample": walk.out_of_sample}),
        "split-required": (split, {"train_period": None, "test_period": None}),
        "split-order": (split, {"train_period": split.test_period}),
        "split-identity": (
            split,
            {
                "candidates": tuple(
                    row.model_copy(update={"test_result": None})
                    for row in split.candidates
                )
            },
        ),
        "split-count": (split, {"period_benchmarks": split.period_benchmarks[:2]}),
        "split-baselines": (
            split,
            {
                "period_benchmarks": tuple(
                    row.model_copy(update={"evaluation_period": split.train_period})
                    for row in split.period_benchmarks
                )
            },
        ),
        "full-period": (full, {"train_period": split.train_period}),
    }
    base, changes = cases[case]
    return base.model_copy(update=changes)


@pytest.mark.parametrize(
    "case,message",
    [
        ("duplicate", "search candidate IDs must be unique"),
        ("sequence", "search candidate sequence must be complete and one-based"),
        ("count", "every search combination must have a result row"),
        ("rank-duplicate", "ranked candidate IDs must be unique"),
        ("rank-missing", "ranking must include every completed candidate once"),
        (
            "walk-required",
            "walk-forward requires windows and a saved out-of-sample result",
        ),
        ("walk-partition", "walk-forward windows must partition ordered candidates"),
        ("walk-ranking", "walk-forward keeps separate training rankings"),
        ("walk-identity", "out-of-sample identity must be separate from training"),
        (
            "walk-window-ranking",
            "every window must retain its complete training ranking",
        ),
        ("walk-contiguous", "out-of-sample windows must be contiguous"),
        ("walk-period", "out-of-sample period must cover every testing window"),
        ("walk-baselines", "walk-forward requires matching out-of-sample benchmarks"),
        ("rolling-mode", "rolling results require walk-forward mode"),
        ("split-required", "split search requires both saved periods"),
        ("split-order", "train and test periods must be disjoint and ordered"),
        ("split-identity", "every split candidate requires a distinct test identity"),
        ("split-count", "split search requires four distinct period baselines"),
        ("split-baselines", "each period requires matching DCA and lump-sum baselines"),
        ("full-period", "full-period search cannot contain split evaluation results"),
    ],
)
def test_search_relationship_first_errors_are_stable(case, message, searches):
    broken = broken_search(case, searches)
    with pytest.raises(ValueError) as caught:
        broken.validate_candidate_identity()
    assert str(caught.value) == message


def test_relationship_error_stays_at_the_model_path_and_precedes_count(searches):
    full = searches["full"]
    broken = full.model_copy(
        update={
            "candidates": (full.candidates[0], full.candidates[0]),
            "total_candidate_count": 9,
        }
    )
    with pytest.raises(ValidationError) as caught:
        SearchResult.model_validate(broken.model_dump(mode="json", by_alias=True))
    error = caught.value.errors()[0]
    assert error["loc"] == ()
    assert error["type"] == "value_error"
    assert error["msg"] == "Value error, search candidate IDs must be unique"


def test_valid_searches_roundtrip_without_mutating_saved_models(searches):
    for original in searches.values():
        saved = original.model_dump(mode="json", by_alias=True)
        assert (
            SearchResult.model_validate(saved).model_dump(mode="json", by_alias=True)
            == saved
        )
        assert original.model_dump(mode="json", by_alias=True) == saved
