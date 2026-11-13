import pytest

from coast_fire.acquire import arcgis, request_json


class Response:
    def __init__(self, value):
        self.value = value

    def raise_for_status(self):
        pass

    def json(self):
        return self.value


class Session:
    def __init__(self, values):
        self.values = iter(values)

    def get(self, *args, **kwargs):
        return Response(next(self.values))


def test_overpass_runtime_remark_never_becomes_partial_success(monkeypatch):
    monkeypatch.setattr("coast_fire.acquire.time.sleep", lambda _: None)
    partial = {"elements": [{"id": 1}], "remark": "runtime error: Query timed out"}
    with pytest.raises(RuntimeError, match="Query timed out"):
        request_json(Session([partial] * 3), "https://example.test", {})


@pytest.mark.parametrize(
    "batch",
    [
        {"features": []},
        {"features": [], "exceededTransferLimit": True},
        {"features": [{"properties": {"FID": 1}, "geometry": None}]},
    ],
)
def test_arcgis_rejects_missing_truncated_or_null_geometry(batch):
    source = {"url": "https://example.test", "id_field": "FID", "fields": ["FID"]}
    with pytest.raises(RuntimeError):
        arcgis(Session([{"objectIds": [1]}, batch]), source, [-124, 38, -123, 40])
